import Anthropic from '@anthropic-ai/sdk'
import {
  AIModelId,
  AIOutputLanguage,
  AIResult,
  IAICommitMessage,
  IAICommitMessageRequest,
  IAIConflictResolutionRequest,
  IAIHunkResolutions,
  IAIRequestOptions,
} from '../lib/ai/types'
import { requestStructuredOutputViaClaudeCode } from './claude-code'

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
    resolutions: {
      type: 'array',
      description: 'One entry per conflict hunk, in the order received.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The hunk index.' },
          resolved: {
            type: 'string',
            description:
              'The text that replaces the whole conflict region (from the <<<<<<< line to the >>>>>>> line, inclusive). No conflict markers. Empty string if the region should disappear.',
          },
          explanation: {
            type: 'string',
            description: 'One short sentence on how and why.',
          },
        },
        required: ['index', 'resolved', 'explanation'],
        additionalProperties: false,
      },
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'low if the intent of either side was unclear and the resolution involved guessing.',
    },
  },
  required: ['resolutions', 'confidence'],
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

You receive the conflict hunks of one file. For each hunk you get the lines right before and after it, the "ours" side (the branch being merged into), the "theirs" side (the branch being merged in) and, when available, the merge base version, which shows what the code looked like before either side changed it. Sometimes you also get the whole file for context.

For every hunk, write the text that replaces the whole conflict region:
- Where both sides made compatible changes, combine them so that both intents are preserved. Where they are genuinely incompatible, pick the side that best keeps the code correct and consistent with the surrounding code.
- Keep the indentation and style of the surrounding code. Don't repeat the context lines before or after the hunk; they stay in the file as they are.
- The result must not contain conflict markers and must leave the file valid (balanced brackets, no duplicated declarations or imports).
- Do not add comments about the merge.

Return exactly one resolution per hunk index. Write each explanation in ${languageNames[language]}, as one short sentence. Set confidence to "low" if you had to guess at either side's intent, "medium" if the resolution is plausible but should be checked carefully, and "high" only when every resolution is unambiguous.`
}

function commitSystemPrompt(language: AIOutputLanguage) {
  return `You write Git commit messages inside GitHub Desktop from the diff of the changes about to be committed. The user will review and can edit the message before committing.

- summary: one line in the imperative mood ("Add", "Fix", "Refactor"...), ideally under 50 characters and never over 72, with no trailing period.
- description: explain what changed and why, as far as the diff shows it. Use short paragraphs or a "- " bullet list, wrapping lines at 72 characters. Use an empty string when the change is trivial and the summary says it all.
- Describe only what the diff supports. Do not invent motivations, issue numbers or test results.
- If the user already started a summary, treat it as a strong hint about their intent.
- Large change sets are abbreviated: you get the list of every changed file with its added/removed line counts, and the diff of some files may be cut short or left out. Use the file list to describe the change as a whole, and focus the description on the most significant changes.

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
  if (options.provider === 'claude-account') {
    return requestStructuredOutputViaClaudeCode(
      options.model,
      system,
      userContent,
      schema,
      effort
    )
  }

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
    return `${e.message} Configure an API key or sign in with your Claude account in Options > AI.`
  }
  return e instanceof Error ? e.message : String(e)
}

export async function resolveConflictWithAI(
  request: IAIConflictResolutionRequest
): Promise<AIResult<IAIHunkResolutions>> {
  const ours = request.ourBranch ?? 'the current branch'
  const theirs = request.theirBranch ?? 'the branch being merged'

  const file =
    request.fileContents === null
      ? ''
      : `<whole_file>\n${request.fileContents}\n</whole_file>\n\n`

  const hunks = request.hunks
    .map(
      h => `<hunk index="${h.index}">
<before>
${h.before}
</before>
<ours>
${h.ours}
</ours>
${h.base === null ? '' : `<base>\n${h.base}\n</base>\n`}<theirs>
${h.theirs}
</theirs>
<after>
${h.after}
</after>
</hunk>`
    )
    .join('\n\n')

  const userContent = `File: ${request.path}
"Ours" branch: ${ours}
"Theirs" branch: ${theirs}

${file}${hunks}`

  try {
    const result = (await requestStructuredOutput(
      request,
      conflictSystemPrompt(request.language),
      userContent,
      conflictResolutionSchema,
      'medium'
    )) as IAIHunkResolutions

    return { kind: 'success', value: result }
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
