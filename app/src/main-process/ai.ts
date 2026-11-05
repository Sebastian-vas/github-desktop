import Anthropic from '@anthropic-ai/sdk'
import {
  AIModelId,
  AIOutputLanguage,
  AIResult,
  IAICommitMessage,
  IAICommitMessageRequest,
  IAIConflictResolution,
  IAIConflictResolutionRequest,
  IAIRequestOptions,
} from '../lib/ai/types'

/**
 * Models that support the server-side refusal fallback. When one of these
 * declines a request, the API transparently retries it on a fallback model
 * within the same call.
 */
const modelsWithServerSideFallback: ReadonlyArray<AIModelId> = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
]

const languageNames: Record<AIOutputLanguage, string> = {
  en: 'English',
  es: 'Spanish',
}

const conflictResolutionSchema = {
  type: 'object',
  properties: {
    resolved_contents: {
      type: 'string',
      description:
        'The complete final contents of the file with every conflict resolved and no conflict markers.',
    },
    explanation: {
      type: 'string',
      description:
        'A short explanation, one bullet per conflict, of how it was resolved and why.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'low if the intent of either side was unclear and the resolution involved guessing.',
    },
  },
  required: ['resolved_contents', 'explanation', 'confidence'],
  additionalProperties: false,
}

const commitMessageSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['summary', 'description'],
  additionalProperties: false,
}

function conflictSystemPrompt(language: AIOutputLanguage) {
  return `You resolve Git merge conflicts inside GitHub Desktop. The user will review your proposal before it is written to disk.

You receive a file that contains conflict regions delimited by "<<<<<<<", "=======" (and possibly "|||||||" for the base) and ">>>>>>>" markers. The "ours" side is the branch being merged into, the "theirs" side is the branch being merged in. When provided, the merge base version shows what the file looked like before either side changed it, so you can tell what each side intended to change.

Produce the complete final file:
- Resolve every conflict region. Where both sides made compatible changes, combine them so that both intents are preserved. Where they are genuinely incompatible, pick the side that best keeps the code correct and consistent with the rest of the file, and say so in the explanation.
- Keep everything outside the conflict regions exactly as it is, including whitespace, indentation and line endings.
- The result must not contain any conflict markers and must be valid for the file's language (balanced brackets, no duplicated declarations or imports).
- Do not add comments to the file about the merge.

Write the explanation in ${languageNames[language]}, as a short bullet list ("- ") with one bullet per conflict region. Set confidence to "low" if you had to guess at either side's intent, "medium" if the resolution is plausible but should be checked carefully, and "high" only when the resolution is unambiguous.`
}

function commitSystemPrompt(language: AIOutputLanguage) {
  return `You write Git commit messages inside GitHub Desktop from the diff of the changes about to be committed. The user will review and can edit the message before committing.

- summary: one line in the imperative mood ("Add", "Fix", "Refactor"...), ideally under 50 characters and never over 72, with no trailing period.
- description: explain what changed and why, as far as the diff shows it. Use short paragraphs or a "- " bullet list, wrapping lines at 72 characters. Use an empty string when the change is trivial and the summary says it all.
- Describe only what the diff supports. Do not invent motivations, issue numbers or test results.
- If the user already started a summary, treat it as a strong hint about their intent.

Write both fields in ${languageNames[language]}.`
}

function createClient(apiKey: string | null) {
  // When no key is configured in the app, the SDK resolves credentials from
  // the environment (ANTHROPIC_API_KEY, etc.).
  return apiKey !== null && apiKey.length > 0
    ? new Anthropic({ apiKey })
    : new Anthropic()
}

/**
 * Sends a single request to Claude asking for a JSON object that matches
 * `schema`, and returns the parsed object.
 */
async function requestStructuredOutput(
  options: IAIRequestOptions,
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
  effort: 'low' | 'medium' | 'high'
): Promise<unknown> {
  const client = createClient(options.apiKey)
  // If the model declines (safety classifiers), let the API retry the request
  // on a fallback model within the same call.
  const fallbackParams = modelsWithServerSideFallback.includes(options.model)
    ? {
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default' as const,
      }
    : {}

  // Streaming avoids HTTP timeouts on large files; we only need the final
  // message, though.
  const stream = client.beta.messages.stream({
    model: options.model,
    max_tokens: 64000,
    ...fallbackParams,
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    system,
    messages: [{ role: 'user', content: userContent }],
  })

  const message = await stream.finalMessage()

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer this request.')
  }

  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'The response from Claude was cut off because it was too long. Try with a smaller file or fewer changes.'
    )
  }

  const text = message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')

  try {
    return JSON.parse(text)
  } catch (e) {
    log.error(`AI: unable to parse response from Claude: ${text}`, e)
    throw new Error('Claude returned a response that could not be read.')
  }
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API key is invalid. Check it in Options > AI.'
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return 'The Anthropic API key does not have access to the selected model.'
  }
  if (e instanceof Anthropic.RateLimitError) {
    return 'The Anthropic API rate limit was reached. Please try again in a moment.'
  }
  if (e instanceof Anthropic.BadRequestError) {
    return `The request was rejected by the Anthropic API: ${e.message}`
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return 'Could not connect to the Anthropic API. Check your internet connection or proxy.'
  }
  if (e instanceof Anthropic.APIError) {
    return `The Anthropic API returned an error (${e.status}): ${e.message}`
  }
  if (e instanceof Anthropic.AnthropicError) {
    // Most commonly: no API key configured anywhere.
    return `${e.message} Configure an API key in Options > AI.`
  }
  return e instanceof Error ? e.message : String(e)
}

export async function resolveConflictWithAI(
  request: IAIConflictResolutionRequest
): Promise<AIResult<IAIConflictResolution>> {
  const ours = request.ourBranch ?? 'the current branch'
  const theirs = request.theirBranch ?? 'the branch being merged'

  const base =
    request.baseContents === null
      ? 'The file did not exist in the merge base (it was added on both sides).'
      : `<merge_base>\n${request.baseContents}\n</merge_base>`

  const userContent = `File: ${request.path}
"Ours" branch: ${ours}
"Theirs" branch: ${theirs}

${base}

<conflicted_file>
${request.conflictedContents}
</conflicted_file>`

  try {
    const result = (await requestStructuredOutput(
      request,
      conflictSystemPrompt(request.language),
      userContent,
      conflictResolutionSchema,
      'high'
    )) as {
      resolved_contents: string
      explanation: string
      confidence: IAIConflictResolution['confidence']
    }

    return {
      kind: 'success',
      value: {
        resolvedContents: result.resolved_contents,
        explanation: result.explanation,
        confidence: result.confidence,
      },
    }
  } catch (e) {
    log.error('AI: conflict resolution failed', e)
    return { kind: 'error', message: describeError(e) }
  }
}

export async function generateCommitMessageWithAI(
  request: IAICommitMessageRequest
): Promise<AIResult<IAICommitMessage>> {
  const hint =
    request.summaryHint.trim().length > 0
      ? `The user started the summary as: "${request.summaryHint.trim()}"\n\n`
      : ''

  const userContent = `${hint}Branch: ${request.branch ?? '(detached HEAD)'}

<diff>
${request.diff}
</diff>`

  try {
    const result = (await requestStructuredOutput(
      request,
      commitSystemPrompt(request.language),
      userContent,
      commitMessageSchema,
      'medium'
    )) as IAICommitMessage

    return {
      kind: 'success',
      value: {
        summary: result.summary.trim(),
        description: result.description.trim(),
      },
    }
  } catch (e) {
    log.error('AI: commit message generation failed', e)
    return { kind: 'error', message: describeError(e) }
  }
}
