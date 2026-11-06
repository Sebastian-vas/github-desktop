import { ChildProcess, spawn } from 'child_process'
import * as Path from 'path'
import * as Os from 'os'
import { access, readdir } from 'fs/promises'
import { constants } from 'fs'
import { shell, WebContents } from 'electron'
import * as ipcWebContents from './ipc-webcontents'
import {
  AIResult,
  ClaudeCommandEvent,
  IClaudeAccountStatus,
  IClaudeCommandRequest,
  IClaudeUsage,
  IClaudeUsageWindow,
} from '../lib/ai/types'

/**
 * Runs requests through the Claude Code CLI (`claude -p`), which uses the
 * Claude account the user signed in with (their subscription) instead of an
 * API key.
 */

const executableName = __WIN32__ ? 'claude.exe' : 'claude'

/** How long a single request may take before we give up */
const RequestTimeout = 10 * 60 * 1000

/** How long we wait for the user to finish signing in in the browser */
const LoginTimeout = 5 * 60 * 1000

async function isExecutable(path: string) {
  try {
    await access(path, __WIN32__ ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Executables bundled with the Claude Code editor extensions, newest version
 * first.
 */
async function getEditorExtensionExecutables(): Promise<string[]> {
  const home = Os.homedir()
  const extensionDirs = [
    '.vscode/extensions',
    '.vscode-insiders/extensions',
    '.vscode-oss/extensions',
    '.cursor/extensions',
    '.windsurf/extensions',
  ].map(d => Path.join(home, d))

  const found = new Array<{ version: number[]; path: string }>()
  for (const dir of extensionDirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const match = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(entry)
      if (match !== null) {
        found.push({
          version: match.slice(1, 4).map(Number),
          path: Path.join(
            dir,
            entry,
            'resources',
            'native-binary',
            executableName
          ),
        })
      }
    }
  }

  found.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.version[i] !== b.version[i]) {
        return b.version[i] - a.version[i]
      }
    }
    return 0
  })
  return found.map(f => f.path)
}

let cachedExecutable: string | null = null

/** Finds the Claude Code CLI, or returns null if it's not installed */
export async function findClaudeExecutable(): Promise<string | null> {
  if (cachedExecutable !== null && (await isExecutable(cachedExecutable))) {
    return cachedExecutable
  }

  const home = Os.homedir()
  // Apps launched from the desktop don't get the shell's PATH, so look in the
  // usual install locations as well.
  const pathDirs = (process.env.PATH ?? '').split(Path.delimiter)
  const candidates = [
    ...pathDirs
      .filter(d => d.length > 0)
      .map(d => Path.join(d, executableName)),
    Path.join(home, '.local', 'bin', executableName),
    Path.join(home, '.claude', 'local', executableName),
    Path.join(home, '.npm-global', 'bin', executableName),
    Path.join(home, '.bun', 'bin', executableName),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
    ...(await getEditorExtensionExecutables()),
  ]

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedExecutable = candidate
      return candidate
    }
  }
  return null
}

interface IProcessResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function childEnvironment() {
  const env = { ...process.env }
  // Otherwise Claude Code would bill an API key instead of the account.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // Don't inherit Electron's "run as node" flags.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function run(
  executable: string,
  args: ReadonlyArray<string>,
  stdin: string | null,
  timeout: number,
  onStdout?: (chunk: string) => void
): Promise<IProcessResult> {
  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd: Os.tmpdir(),
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      onStdout?.(chunk)
    })
    child.on('error', e => {
      clearTimeout(timer)
      resolve({
        exitCode: -1,
        stdout,
        stderr: `${stderr}${e.message}`,
        timedOut,
      })
    })
    child.on('close', exitCode => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })

    // Ignore EPIPE if the process exits before reading everything.
    child.stdin.on('error', () => {})
    if (stdin !== null) {
      child.stdin.end(stdin, 'utf8')
    } else {
      child.stdin.end()
    }
  })
}

const NotInstalledMessage =
  'Claude Code was not found on this computer. Install it from https://claude.com/claude-code, or use an API key in Options > AI.'

const NotLoggedInMessage =
  'Your Claude account is not signed in. Sign in from Options > AI.'

export async function getClaudeAccountStatus(): Promise<IClaudeAccountStatus> {
  const executable = await findClaudeExecutable()
  if (executable === null) {
    return { kind: 'not-installed' }
  }

  const result = await run(executable, ['auth', 'status'], null, 30_000)
  try {
    const status = JSON.parse(result.stdout)
    if (status.loggedIn !== true) {
      return { kind: 'logged-out', executable }
    }
    return {
      kind: 'logged-in',
      executable,
      email: typeof status.email === 'string' ? status.email : null,
      plan:
        typeof status.subscriptionType === 'string'
          ? status.subscriptionType
          : null,
    }
  } catch {
    if (result.exitCode !== 0) {
      return { kind: 'logged-out', executable }
    }
    return {
      kind: 'error',
      message: `Unexpected answer from Claude Code: ${result.stdout}${result.stderr}`,
    }
  }
}

/**
 * Starts the Claude account sign in, which happens in the browser, and waits
 * for it to finish.
 */
export async function loginToClaudeAccount(): Promise<IClaudeAccountStatus> {
  const executable = await findClaudeExecutable()
  if (executable === null) {
    return { kind: 'not-installed' }
  }

  // Claude Code tries to open the browser itself; in case it can't, open the
  // first sign in URL it prints.
  let openedUrl = false
  const result = await run(
    executable,
    ['auth', 'login', '--claudeai'],
    null,
    LoginTimeout,
    chunk => {
      const match = /https:\/\/\S+/.exec(chunk)
      if (!openedUrl && match !== null) {
        openedUrl = true
        shell.openExternal(match[0]).catch(() => {})
      }
    }
  )

  const status = await getClaudeAccountStatus()
  if (status.kind === 'logged-out' && result.exitCode !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim()
    return {
      kind: 'error',
      message: result.timedOut
        ? 'The sign in took too long. Please try again.'
        : `Sign in did not complete. You can also run "claude auth login" in a terminal.${
            output.length > 0 ? `\n\n${output}` : ''
          }`,
    }
  }
  return status
}

// ------------------------------------------------------------ plan usage

/** Last known usage of the Claude plan, from Claude Code's rate limit events */
let latestUsage: IClaudeUsage | null = null

function toWindow(value: unknown): IClaudeUsageWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const w = value as Record<string, unknown>
  if (typeof w.utilization !== 'number') {
    return null
  }
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null,
    status: typeof w.status === 'string' ? w.status : 'allowed',
  }
}

/** Records the plan usage carried by a stream-json message, if any */
function recordUsage(message: any) {
  if (message?.type !== 'rate_limit_event') {
    return
  }
  const info = message.rate_limit_info ?? {}
  const windows = info.unifiedWindows ?? {}
  let fiveHour = toWindow(windows.five_hour)
  let sevenDay = toWindow(windows.seven_day)
  if (fiveHour === null && info.rateLimitType === 'five_hour') {
    fiveHour = toWindow(info)
  }
  if (sevenDay === null && info.rateLimitType === 'seven_day') {
    sevenDay = toWindow(info)
  }
  if (fiveHour === null && sevenDay === null) {
    return
  }
  latestUsage = {
    fiveHour: fiveHour ?? latestUsage?.fiveHour ?? null,
    sevenDay: sevenDay ?? latestUsage?.sevenDay ?? null,
    updatedAt: Date.now(),
  }
}

export function getClaudeUsage(): IClaudeUsage | null {
  return latestUsage
}

/** Reads the plan usage with the smallest possible request */
export async function refreshClaudeUsage(): Promise<IClaudeUsage | null> {
  try {
    await requestStructuredOutputViaClaudeCode(
      'claude-haiku-5-5',
      'Answer with the word ok.',
      'ok',
      {
        type: 'object',
        properties: { ok: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
      'low'
    )
  } catch (e) {
    log.warn('AI: could not refresh the plan usage', e)
  }
  return latestUsage
}

/**
 * Sends a single prompt to Claude through Claude Code and returns the object
 * matching `schema`. No tools are enabled: Claude only reads what we send.
 */
export async function requestStructuredOutputViaClaudeCode(
  model: string,
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
  effort: 'low' | 'medium' | 'high'
): Promise<unknown> {
  const executable = await findClaudeExecutable()
  if (executable === null) {
    throw new Error(NotInstalledMessage)
  }

  const result = await run(
    executable,
    [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(schema),
      '--system-prompt',
      system,
      '--tools',
      '',
      '--model',
      model,
      '--effort',
      effort,
      '--no-session-persistence',
      // Skip the user's hooks, plugins and project settings.
      '--setting-sources',
      '',
    ],
    userContent,
    RequestTimeout
  )

  if (result.timedOut) {
    throw new Error('Claude took too long to answer. Please try again.')
  }

  let output:
    | {
        is_error?: boolean
        subtype?: string
        result?: string
        structured_output?: unknown
      }
    | undefined
  for (const line of result.stdout.split('\n')) {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    recordUsage(message)
    if (message?.type === 'result') {
      output = message
    }
  }

  if (output === undefined) {
    const text = `${result.stdout}\n${result.stderr}`.trim()
    log.error(`AI: unexpected output from Claude Code: ${text}`)
    if (/not logged in|\/login|authenticat/i.test(text)) {
      throw new Error(NotLoggedInMessage)
    }
    throw new Error(`Claude Code failed: ${text.slice(0, 1000)}`)
  }

  if (output.is_error === true || output.subtype !== 'success') {
    const message = output.result ?? output.subtype ?? 'unknown error'
    if (/not logged in|\/login|invalid api key|oauth/i.test(message)) {
      throw new Error(NotLoggedInMessage)
    }
    throw new Error(`Claude could not complete the request: ${message}`)
  }

  if (output.structured_output !== undefined) {
    return output.structured_output
  }

  try {
    return JSON.parse(output.result ?? '')
  } catch {
    log.error(`AI: unable to parse response from Claude: ${output.result}`)
    throw new Error('Claude returned a response that could not be read.')
  }
}

// ------------------------------------------------------ repository commands

/** Commands (skills) currently running, by run id */
const runningCommands = new Map<string, ChildProcess>()

function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const i = input as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof i[key] === 'string' && (i[key] as string).length > 0) {
        return i[key] as string
      }
    }
    return null
  }
  const value =
    name === 'Bash'
      ? pick('description', 'command')
      : pick(
          'file_path',
          'path',
          'pattern',
          'skill',
          'description',
          'url',
          'query',
          'prompt'
        )
  const text = value ?? JSON.stringify(input)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(c =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : ''
      )
      .join('')
  }
  return ''
}

/** Turns a line of Claude Code's stream-json output into events */
function parseStreamLine(line: string): ClaudeCommandEvent[] {
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    return []
  }
  recordUsage(message)

  const events = new Array<ClaudeCommandEvent>()
  switch (message.type) {
    case 'system':
      if (
        message.subtype === 'init' &&
        typeof message.session_id === 'string'
      ) {
        events.push({ kind: 'session', sessionId: message.session_id })
      }
      break
    case 'assistant':
      // Only the main conversation, not what subagents do.
      if (message.parent_tool_use_id) {
        break
      }
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim().length > 0) {
          events.push({ kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          events.push({
            kind: 'tool',
            id: block.id,
            name: block.name,
            summary: summarizeToolInput(block.name, block.input),
          })
        }
      }
      break
    case 'user':
      if (message.parent_tool_use_id) {
        break
      }
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const output = toolResultText(block.content)
          events.push({
            kind: 'tool-result',
            id: block.tool_use_id,
            isError: block.is_error === true,
            output: output.length > 2000 ? `${output.slice(0, 2000)}…` : output,
          })
        }
      }
      break
    case 'result':
      events.push({
        kind: 'result',
        isError: message.is_error === true || message.subtype !== 'success',
        text:
          typeof message.result === 'string'
            ? message.result
            : message.subtype ?? '',
        durationMs:
          typeof message.duration_ms === 'number' ? message.duration_ms : null,
        turns: typeof message.num_turns === 'number' ? message.num_turns : null,
      })
      break
  }
  return events
}

/**
 * Runs a prompt (usually a project skill such as "/pull") with Claude Code in
 * the repository, streaming what Claude does to the renderer.
 */
export async function startClaudeCommand(
  request: IClaudeCommandRequest,
  sender: WebContents
): Promise<AIResult<null>> {
  const executable = await findClaudeExecutable()
  if (executable === null) {
    return { kind: 'error', message: NotInstalledMessage }
  }

  const send = (event: ClaudeCommandEvent) => {
    if (!sender.isDestroyed()) {
      ipcWebContents.send(sender, 'claude-command-event', request.runId, event)
    }
  }

  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    request.model,
    '--permission-mode',
    request.permission,
  ]
  if (request.resumeSessionId !== null) {
    args.push('--resume', request.resumeSessionId)
  }

  let child: ChildProcess
  try {
    child = spawn(executable, args, {
      cwd: request.cwd,
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    return { kind: 'error', message: `Could not start Claude Code: ${e}` }
  }

  runningCommands.set(request.runId, child)

  let buffer = ''
  let stderr = ''
  let sawResult = false
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'result') {
          sawResult = true
        }
        send(event)
      }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.on('error', e => {
    runningCommands.delete(request.runId)
    send({ kind: 'exit', code: -1, error: e.message })
  })
  child.on('close', code => {
    runningCommands.delete(request.runId)
    for (const event of parseStreamLine(buffer.trim())) {
      send(event)
    }
    const error =
      !sawResult && stderr.trim().length > 0
        ? /not logged in|\/login/i.test(stderr)
          ? NotLoggedInMessage
          : stderr.trim().slice(-2000)
        : null
    send({ kind: 'exit', code, error })
  })

  child.stdin?.on('error', () => {})
  child.stdin?.end(request.prompt, 'utf8')

  return { kind: 'success', value: null }
}

export function stopClaudeCommand(runId: string) {
  const child = runningCommands.get(runId)
  if (child !== undefined) {
    child.kill()
    runningCommands.delete(runId)
  }
}
