import * as Path from 'path'
import { readFile } from 'fs/promises'
import { invoke } from '../ipc-renderer'
import { git } from '../git/core'
import { Repository } from '../../models/repository'
import { Account } from '../../models/account'
import { API } from '../api'
import { getAccountForRepository } from '../get-account-for-repository'
import { getAIRequestOptions, getAISettings } from './settings'
import { compactDiff } from './index'
import { readCommitConventions, readProjectGuidelines } from './project-context'
import {
  AIResult,
  AITaskKind,
  IAIBranchName,
  IAIExplanation,
  IAIPullRequest,
  IAIRecovery,
  IAIReleaseNotes,
} from './types'

/**
 * The smaller AI helpers: each one gathers its context from git (and GitHub)
 * here, in the renderer, and asks Claude through the shared `ai-task`
 * channel.
 */

async function runTask<T>(
  kind: AITaskKind,
  input: string
): Promise<AIResult<T>> {
  const options = await getAIRequestOptions()
  const result = await invoke('ai-task', { ...options, kind, input })
  return result as AIResult<T>
}

/** Runs git and returns its output, or '' when it fails */
async function gitOutput(repository: Repository, args: string[]) {
  try {
    const result = await git(args, repository.path, 'ai-task-context', {
      successExitCodes: new Set(Array.from({ length: 256 }, (_, i) => i)),
    })
    return result.exitCode === 0 ? result.stdout.trim() : ''
  } catch {
    return ''
  }
}

function section(name: string, content: string) {
  return content.length > 0 ? `<${name}>\n${content}\n</${name}>` : ''
}

function join(...parts: string[]) {
  return parts.filter(p => p.length > 0).join('\n\n')
}

// ------------------------------------------------------------- branch name

export async function suggestBranchName(
  repository: Repository,
  description: string
): Promise<AIResult<IAIBranchName>> {
  const branches = await gitOutput(repository, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=60',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ])
  const changed = await gitOutput(repository, ['status', '--short'])

  return runTask<IAIBranchName>(
    'branch-name',
    join(
      section('what_the_user_will_do', description),
      section('existing_branches', branches),
      section(
        'files_changed_so_far',
        changed.split('\n').slice(0, 40).join('\n')
      )
    )
  )
}

// ------------------------------------------------------------ pull request

async function readPullRequestTemplate(repository: Repository) {
  for (const file of [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'docs/pull_request_template.md',
  ]) {
    try {
      return await readFile(Path.join(repository.path, file), 'utf8')
    } catch {
      continue
    }
  }
  return ''
}

export async function generatePullRequest(
  repository: Repository,
  base: string,
  head: string
): Promise<AIResult<IAIPullRequest>> {
  const range = `${base}...${head}`
  const commits = await gitOutput(repository, [
    'log',
    '--no-merges',
    '--format=%h %s%n%b',
    range,
  ])
  if (commits.length === 0) {
    return {
      kind: 'error',
      message: `${head} has no commits that ${base} doesn't have.`,
    }
  }
  const diff = await gitOutput(repository, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    range,
  ])
  const template = await readPullRequestTemplate(repository)
  const conventions = getAISettings().useProjectContext
    ? (await readCommitConventions(repository, 8_000)).text
    : ''

  return runTask<IAIPullRequest>(
    'pull-request',
    join(
      section('project_conventions', conventions),
      section('pull_request_template', template),
      `Pull request from ${head} into ${base}.`,
      section('commits', commits.slice(0, 20_000)),
      section('diff', compactDiff(diff, 100_000))
    )
  )
}

/** Opens the pull request on GitHub with the account of the repository */
export async function openPullRequest(
  repository: Repository,
  accounts: ReadonlyArray<Account>,
  pullRequest: {
    title: string
    body: string
    head: string
    base: string
    draft: boolean
  }
): Promise<string> {
  const gitHubRepository = repository.gitHubRepository
  if (gitHubRepository === null) {
    throw new Error('This repository is not on GitHub.')
  }
  const account = getAccountForRepository(accounts, repository)
  if (account === null) {
    throw new Error('Sign in to GitHub in Options > Accounts first.')
  }
  return API.fromAccount(account).createPullRequest(
    gitHubRepository.owner.login,
    gitHubRepository.name,
    pullRequest
  )
}

// ----------------------------------------------------------- release notes

export async function generateReleaseNotes(
  repository: Repository,
  range: string,
  version: string | null,
  production: string
): Promise<AIResult<IAIReleaseNotes>> {
  const commits = await gitOutput(repository, [
    'log',
    '--no-merges',
    '--format=- %h %s (%an)%n%b',
    range,
  ])
  const stat = await gitOutput(repository, [
    'diff',
    '--stat=120',
    '--find-renames',
    range,
  ])
  return runTask<IAIReleaseNotes>(
    'release-notes',
    join(
      `Release to ${production}${
        version !== null ? `, version ${version}` : ''
      }.`,
      section('commits', commits.slice(0, 40_000)),
      section('files_changed', stat.slice(0, 30_000))
    )
  )
}

// ---------------------------------------------------------------- recovery

export async function diagnoseRecovery(
  repository: Repository,
  problem: string
): Promise<AIResult<IAIRecovery>> {
  const gitDir = await gitOutput(repository, [
    'rev-parse',
    '--absolute-git-dir',
  ])
  const markers = new Array<string>()
  for (const marker of [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
  ]) {
    try {
      await readFile(Path.join(gitDir, marker))
      markers.push(marker)
    } catch (e) {
      // EISDIR means the marker directory exists
      if ((e as NodeJS.ErrnoException).code === 'EISDIR') {
        markers.push(marker)
      }
    }
  }

  const [status, branches, reflog, history, stashes] = await Promise.all([
    gitOutput(repository, ['status', '--branch', '--short']),
    gitOutput(repository, [
      'for-each-ref',
      '--sort=-committerdate',
      '--count=30',
      '--format=%(refname:short) %(objectname:short) %(upstream:short) %(upstream:track) %(committerdate:relative)',
      'refs/heads',
      'refs/remotes',
    ]),
    gitOutput(repository, [
      'reflog',
      '-40',
      '--date=relative',
      '--format=%h %gd %gs (%cr)',
    ]),
    gitOutput(repository, [
      'log',
      '--graph',
      '--oneline',
      '--decorate',
      '--all',
      '-30',
    ]),
    gitOutput(repository, ['stash', 'list', '--format=%gd %h %cr %s']),
  ])

  return runTask<IAIRecovery>(
    'recovery',
    join(
      section('what_the_user_says', problem),
      section(
        'operation_in_progress',
        markers.length > 0 ? markers.join(', ') : 'none'
      ),
      section('status', status),
      section('branches', branches),
      section('reflog', reflog),
      section('recent_history', history),
      section('stash_list', stashes || '(empty)')
    )
  )
}

// ---------------------------------------------------------------- explain

export async function explainCommit(
  repository: Repository,
  sha: string
): Promise<AIResult<IAIExplanation>> {
  const header = await gitOutput(repository, [
    'show',
    '--no-patch',
    '--format=fuller',
    sha,
  ])
  const stat = await gitOutput(repository, [
    'show',
    '--stat=120',
    '--format=',
    sha,
  ])
  const diff = await gitOutput(repository, [
    'show',
    '--no-color',
    '--no-ext-diff',
    '--format=',
    sha,
  ])
  const guidelines = getAISettings().useProjectContext
    ? (await readProjectGuidelines(repository, 15_000)).text
    : ''
  return runTask<IAIExplanation>(
    'explain-commit',
    join(
      section('project_instructions', guidelines),
      section('commit', header),
      section('files', stat),
      section('diff', compactDiff(diff, 90_000))
    )
  )
}

/** The latest failed GitHub Actions run of a branch, explained */
export async function explainLatestCIFailure(
  repository: Repository,
  accounts: ReadonlyArray<Account>,
  branch: string
): Promise<
  AIResult<
    IAIExplanation & { readonly runUrl: string; readonly runName: string }
  >
> {
  const gitHubRepository = repository.gitHubRepository
  if (gitHubRepository === null) {
    return { kind: 'error', message: 'This repository is not on GitHub.' }
  }
  const account = getAccountForRepository(accounts, repository)
  if (account === null) {
    return {
      kind: 'error',
      message: 'Sign in to GitHub in Options > Accounts to read the CI logs.',
    }
  }

  const api = API.fromAccount(account)
  const owner = gitHubRepository.owner.login
  const name = gitHubRepository.name
  const runs = await api.fetchWorkflowRunsForBranch(owner, name, branch)
  const failed = runs.find(r => r.conclusion === 'failure')
  if (failed === undefined) {
    return {
      kind: 'error',
      message: `No failed GitHub Actions runs on ${branch} recently.`,
    }
  }

  const jobs = await api.fetchWorkflowRunJobs(owner, name, failed.id)
  const failedJobs = (jobs?.jobs ?? []).filter(j => j.conclusion === 'failure')
  const logs = new Array<string>()
  for (const job of failedJobs.slice(0, 3)) {
    const failedSteps = job.steps
      .filter(s => s.conclusion === 'failure')
      .map(s => s.name)
      .join(', ')
    const log = (await api.fetchJobLogs(owner, name, job.id)) ?? ''
    // The end of the log is where the error is.
    const tail = log.split('\n').slice(-400).join('\n').slice(-40_000)
    logs.push(
      section(
        'job',
        `Job: ${job.name}\nFailed steps: ${failedSteps || 'unknown'}\n\n${
          tail || '(the log could not be read)'
        }`
      )
    )
  }

  const result = await runTask<IAIExplanation>(
    'explain-ci',
    join(
      `Workflow "${failed.name}" on ${branch} (${
        failed.html_url
      }), commit ${failed.head_sha.slice(0, 7)}.`,
      logs.length > 0
        ? logs.join('\n\n')
        : 'No job logs could be read; explain with what is known.'
    )
  )
  if (result.kind === 'error') {
    return result
  }
  return {
    kind: 'success',
    value: { ...result.value, runUrl: failed.html_url, runName: failed.name },
  }
}

// ------------------------------------------------------------ team summary

export async function summarizeTeamActivity(
  repository: Repository,
  mainRef: string,
  branchReport: string
): Promise<AIResult<IAIExplanation>> {
  const arrived = await gitOutput(repository, [
    'log',
    '--no-merges',
    '--since=14 days ago',
    '--format=- %h %an, %ar: %s',
    '--shortstat',
    mainRef,
  ])
  const notMine = await gitOutput(repository, [
    'log',
    '--no-merges',
    '--format=- %h %an: %s',
    `HEAD..${mainRef}`,
  ])
  return runTask<IAIExplanation>(
    'team-summary',
    join(
      section(`commits_on_${mainRef}_last_14_days`, arrived.slice(0, 60_000)),
      section('commits_not_yet_in_my_branch', notMine.slice(0, 20_000)),
      section('branches', branchReport)
    )
  )
}
