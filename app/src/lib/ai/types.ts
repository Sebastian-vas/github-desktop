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

/**
 * How requests reach Claude:
 * - claude-account: through the Claude Code CLI, signed in with the user's
 *   own Claude account (uses their subscription, no API key needed).
 * - api-key: directly against the Anthropic API with an API key.
 */
export type AIProvider = 'claude-account' | 'api-key'

export const DefaultAIProvider: AIProvider = 'claude-account'

/** The language Claude should write commit messages and explanations in. */
export type AIOutputLanguage = 'en' | 'es'

/** Options common to every AI request */
export interface IAIRequestOptions {
  readonly provider: AIProvider
  /**
   * The Anthropic API key. When null, the main process falls back to the
   * ANTHROPIC_API_KEY environment variable.
   */
  readonly apiKey: string | null
  readonly model: AIModelId
  readonly language: AIOutputLanguage
}

/** One conflict region of a file, as sent to Claude */
export interface IAIConflictHunk {
  /** Index of the hunk within the file, used to match the answer back */
  readonly index: number
  /** Lines right before the conflict region */
  readonly before: string
  readonly ours: string
  /** The merge base version of the region, when the markers include it */
  readonly base: string | null
  readonly theirs: string
  /** Lines right after the conflict region */
  readonly after: string
}

/**
 * Asks Claude to resolve some of the conflict regions of a file. Only the
 * regions (with some context) travel and come back, so the answer is short
 * and fast even for large files; the file is reassembled in the renderer.
 */
export interface IAIConflictResolutionRequest extends IAIRequestOptions {
  /** Path of the conflicted file, relative to the repository root */
  readonly path: string
  /**
   * The whole conflicted file, for context, when it's small enough. When
   * null, Claude only sees the context lines around each hunk.
   */
  readonly fileContents: string | null
  readonly hunks: ReadonlyArray<IAIConflictHunk>
  readonly ourBranch: string | null
  readonly theirBranch: string | null
}

export interface IAIHunkResolution {
  readonly index: number
  /** Replacement for the whole conflict region, markers included */
  readonly resolved: string
  readonly explanation: string
}

export interface IAIHunkResolutions {
  readonly resolutions: ReadonlyArray<IAIHunkResolution>
  readonly confidence: AIConfidence
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

/** Whether Claude Code is installed and signed in, for the preferences */
export type IClaudeAccountStatus =
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'logged-out'; readonly executable: string }
  | {
      readonly kind: 'logged-in'
      readonly executable: string
      readonly email: string | null
      readonly plan: string | null
    }
  | { readonly kind: 'error'; readonly message: string }
