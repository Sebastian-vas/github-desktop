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
  /** The project's instructions (CLAUDE.md…), or null */
  readonly projectContext: string | null
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
  /** The project's commit conventions and recent subjects, or null */
  readonly projectContext: string | null
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

export interface IAIReviewRequest extends IAIRequestOptions {
  /** Unified diff of the changes about to be committed (may be abbreviated) */
  readonly diff: string
  readonly branch: string | null
  /** The project's instructions and review agents, or null */
  readonly projectContext: string | null
}

export type AIReviewSeverity = 'high' | 'medium' | 'low'

export interface IAIReviewFinding {
  readonly severity: AIReviewSeverity
  /** Repository-relative path, or null for findings about the whole change */
  readonly file: string | null
  /** Line in the new version of the file, or null */
  readonly line: number | null
  readonly title: string
  readonly detail: string
  readonly suggestion: string
  /** Which project rule it breaks, if any (e.g. "CLAUDE.md › Dates") */
  readonly rule: string | null
}

export interface IAIReview {
  readonly verdict: 'pass' | 'warnings' | 'issues'
  readonly summary: string
  readonly findings: ReadonlyArray<IAIReviewFinding>
}

/** How much Claude may do on its own while running a repository command */
export type ClaudeCommandPermission =
  | 'auto'
  | 'acceptEdits'
  | 'bypassPermissions'

export interface IClaudeCommandRequest {
  /** Identifies the run in the events sent back */
  readonly runId: string
  /** Repository the command runs in */
  readonly cwd: string
  /** The prompt, e.g. "/pull" or "/release-produccion commit_primero=si" */
  readonly prompt: string
  readonly model: AIModelId
  readonly permission: ClaudeCommandPermission
  /** Continue a previous run's conversation (to answer its questions) */
  readonly resumeSessionId: string | null
}

/** Progress of a repository command, streamed to the renderer */
export type ClaudeCommandEvent =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly summary: string
    }
  | {
      readonly kind: 'tool-result'
      readonly id: string
      readonly isError: boolean
      readonly output: string
    }
  | {
      readonly kind: 'result'
      readonly isError: boolean
      readonly text: string
      readonly durationMs: number | null
      readonly turns: number | null
    }
  | {
      readonly kind: 'exit'
      readonly code: number | null
      readonly error: string | null
    }

// ------------------------------------------------------------- AI tasks

/** Smaller AI helpers that share one request channel */
export type AITaskKind =
  | 'branch-name'
  | 'pull-request'
  | 'release-notes'
  | 'recovery'
  | 'explain-commit'
  | 'explain-ci'
  | 'team-summary'

export interface IAITaskRequest extends IAIRequestOptions {
  readonly kind: AITaskKind
  /** Everything the task needs, already gathered by the renderer */
  readonly input: string
}

export interface IAIBranchName {
  readonly name: string
  readonly alternatives: ReadonlyArray<string>
}

export interface IAIPullRequest {
  readonly title: string
  readonly body: string
}

export interface IAIReleaseNotes {
  readonly title: string
  readonly notes: string
}

export interface IAIRecoveryStep {
  readonly title: string
  readonly explanation: string
  /** A git command to run, or null for a manual step */
  readonly command: string | null
  /** True when the command can't lose any work */
  readonly safe: boolean
}

export interface IAIRecovery {
  readonly diagnosis: string
  readonly steps: ReadonlyArray<IAIRecoveryStep>
}

/** Explanations: a commit, a CI failure, what the team did */
export interface IAIExplanation {
  readonly summary: string
  readonly details: string
}

// ----------------------------------------------------------- plan usage

export interface IClaudeUsageWindow {
  /** 0 to 1 */
  readonly utilization: number
  /** Unix time (seconds) when the window resets, or null */
  readonly resetsAt: number | null
  readonly status: string
}

export interface IClaudeUsage {
  readonly fiveHour: IClaudeUsageWindow | null
  readonly sevenDay: IClaudeUsageWindow | null
  /** When it was read (ms since epoch) */
  readonly updatedAt: number
}

// ------------------------------------------------------- shell commands

export type ShellCommandEvent =
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'exit'; readonly code: number | null }
