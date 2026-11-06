import { ChildProcess, spawn } from 'child_process'
import { WebContents } from 'electron'
import * as ipcWebContents from './ipc-webcontents'
import { AIResult } from '../lib/ai/types'

/**
 * Runs a command the user chose to run (a "what's next" hint, a recovery
 * step) in the repository, streaming its output to the renderer.
 */

const running = new Map<string, ChildProcess>()

/** Output beyond this is dropped, to keep the UI responsive */
const MaxOutput = 200_000

export function startShellCommand(
  runId: string,
  cwd: string,
  command: string,
  sender: WebContents
): AIResult<null> {
  const send = (
    event:
      | { kind: 'output'; text: string }
      | { kind: 'exit'; code: number | null }
  ) => {
    if (!sender.isDestroyed()) {
      ipcWebContents.send(sender, 'shell-command-event', runId, event)
    }
  }

  let child: ChildProcess
  try {
    // A login shell, so tools installed for the user (docker, php, nvm…)
    // are on the PATH even when Desktop was opened from the desktop.
    child = __WIN32__
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          windowsHide: true,
        })
      : spawn(process.env.SHELL || '/bin/bash', ['-lc', command], { cwd })
  } catch (e) {
    return { kind: 'error', message: `Could not start the command: ${e}` }
  }

  running.set(runId, child)
  let sent = 0
  const onData = (chunk: Buffer) => {
    if (sent >= MaxOutput) {
      return
    }
    const text = chunk.toString('utf8')
    sent += text.length
    send({
      kind: 'output',
      text: sent >= MaxOutput ? `${text}\n[… output truncated]\n` : text,
    })
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', e => {
    running.delete(runId)
    send({ kind: 'output', text: `${e.message}\n` })
    send({ kind: 'exit', code: -1 })
  })
  child.on('close', code => {
    running.delete(runId)
    send({ kind: 'exit', code })
  })

  return { kind: 'success', value: null }
}

export function stopShellCommand(runId: string) {
  const child = running.get(runId)
  if (child !== undefined) {
    child.kill()
    running.delete(runId)
  }
}
