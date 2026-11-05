/**
 * Types shared between the renderer and the main process for the AI
 * (Claude) assisted features: merge conflict resolution and commit message
 * generation.
 *
 * This file must not import any Node or Electron modules since it's used from
 * both processes.
 */

/** Claude models the user can pick from in the preferences. */
export const AIModels = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
] as const

export type AIModelId = typeof AIModels[number]['id']

export const DefaultAIModel: AIModelId = 'claude-opus-5-5'

/** The language Claude should write commit messages and explanations in. */
export type AIOutputLanguage = 'en' | 'es'

/** Options common to every AI request */
export interface IAIRequestOptions {
  /**
   * The Anthropic API key. When null, the main process falls back to the
   * ANTHROPIC_API_KEY environment variable.
   */
  readonly apiKey: string | null
  readonly model: AIModelId
  readonly language: AIOutputLanguage
}

export interface IAIConflictResolutionRequest extends IAIRequestOptions {
  /** Path of the conflicted file, relative to the repository root */
  readonly path: string
  /** Current contents of the file, including conflict markers */
  readonly conflictedContents: string
  /**
   * Contents of the file in the merge base (stage 1 in the index), if the
   * file existed there. Gives Claude the context of what each side changed.
   */
  readonly baseContents: string | null
  readonly ourBranch: string | null
  readonly theirBranch: string | null
}

export type AIConfidence = 'high' | 'medium' | 'low'

export interface IAIConflictResolution {
  /** The full proposed contents of the file, without conflict markers */
  readonly resolvedContents: string
  /** Human readable explanation of how each conflict was resolved */
  readonly explanation: string
  readonly confidence: AIConfidence
}

export interface IAICommitMessageRequest extends IAIRequestOptions {
  /** Unified diff of the changes that will be committed */
  readonly diff: string
  readonly branch: string | null
  /** Whatever the user already typed in the summary, used as a hint */
  readonly summaryHint: string
}

export interface IAICommitMessage {
  readonly summary: string
  readonly description: string
}

/**
 * Result returned over IPC. Errors are returned as values rather than thrown
 * since Electron mangles errors thrown from `ipcMain.handle`.
 */
export type AIResult<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'error'; readonly message: string }
