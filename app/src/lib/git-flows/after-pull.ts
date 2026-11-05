import * as Path from 'path'
import { readFile } from 'fs/promises'
import { IFlowNote } from './flow-run'

/**
 * Rules that turn the files a pull changed into "what to do next" hints
 * (run the migrations, install dependencies, rebuild…).
 *
 * Besides the built-in rules, a repository can add its own (or replace the
 * built-in ones) in `.github/desktop-flows.json` or `.desktop-flows.json`:
 *
 *   {
 *     "productionBranch": "prod",
 *     "afterPull": [
 *       { "paths": ["database/modseeders/**"], "title": "Rebuild the database",
 *         "detail": "New seed data arrived.", "command": "./flow.sh" }
 *     ],
 *     "replaceDefaultAfterPull": false
 *   }
 */
export interface IAfterPullRule {
  /** Glob patterns (`*`, `**`) matched against the changed paths */
  readonly paths: ReadonlyArray<string>
  readonly title: string
  readonly detail?: string
  readonly command?: string
}

export interface IRepositoryFlowsConfig {
  readonly productionBranch?: string
  readonly afterPull?: ReadonlyArray<IAfterPullRule>
  readonly replaceDefaultAfterPull?: boolean
}

export const DefaultAfterPullRules: ReadonlyArray<IAfterPullRule> = [
  {
    paths: [
      'database/migrations/**',
      '**/migrations/**',
      'db/migrate/**',
      'prisma/schema.prisma',
    ],
    title: 'Run the database migrations',
    detail: 'New migrations arrived.',
  },
  {
    paths: [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '**/package.json',
    ],
    title: 'Install the JavaScript dependencies',
    detail: 'package.json or the lock file changed.',
  },
  {
    paths: [
      'resources/js/**',
      'resources/css/**',
      'vite.config.*',
      'webpack.config.*',
      'tailwind.config.*',
    ],
    title: 'Rebuild the frontend',
    detail: 'Frontend sources or their build configuration changed.',
  },
  {
    paths: ['composer.json', 'composer.lock'],
    title: 'Install the PHP dependencies',
    command: 'composer install',
  },
  {
    paths: [
      'requirements*.txt',
      'pyproject.toml',
      'poetry.lock',
      'Pipfile.lock',
      'uv.lock',
    ],
    title: 'Install the Python dependencies',
  },
  {
    paths: ['Gemfile', 'Gemfile.lock'],
    title: 'Install the Ruby gems',
    command: 'bundle install',
  },
  {
    paths: ['go.mod', 'go.sum'],
    title: 'Download the Go modules',
    command: 'go mod download',
  },
  {
    paths: ['Cargo.toml', 'Cargo.lock'],
    title: 'Rebuild the Rust crates',
    command: 'cargo build',
  },
  {
    paths: [
      'Dockerfile',
      '**/Dockerfile',
      'docker-compose*.yml',
      'compose*.yml',
      '.docker/**',
    ],
    title: 'Rebuild the containers',
    detail: 'The Docker setup changed.',
  },
  {
    paths: ['.env.example', '.env.*.example'],
    title: 'Check your .env',
    detail: 'The example environment file changed: there may be new settings.',
  },
]

/** Converts a glob with `*` and `**` into a regular expression */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches any number of directories (including none)
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (c === '?') {
      source += '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesAnyGlob(path: string, globs: ReadonlyArray<string>) {
  return globs.some(g => globToRegExp(g).test(path))
}

/** Reads the repository's flow configuration, if it has one */
export async function readRepositoryFlowsConfig(
  repositoryPath: string
): Promise<IRepositoryFlowsConfig> {
  for (const file of ['.github/desktop-flows.json', '.desktop-flows.json']) {
    try {
      const contents = await readFile(Path.join(repositoryPath, file), 'utf8')
      const parsed = JSON.parse(contents)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      continue
    }
  }
  return {}
}

/** The hints that apply to the changed files */
export function getAfterPullNotes(
  changedFiles: ReadonlyArray<string>,
  config: IRepositoryFlowsConfig
): ReadonlyArray<IFlowNote> {
  const custom = Array.isArray(config.afterPull) ? config.afterPull : []
  const rules =
    config.replaceDefaultAfterPull === true
      ? custom
      : [...custom, ...DefaultAfterPullRules]

  const notes = new Array<IFlowNote>()
  const seen = new Set<string>()
  for (const rule of rules) {
    if (
      !Array.isArray(rule.paths) ||
      typeof rule.title !== 'string' ||
      seen.has(rule.title)
    ) {
      continue
    }
    const matched = changedFiles.filter(f => matchesAnyGlob(f, rule.paths))
    if (matched.length === 0) {
      continue
    }
    seen.add(rule.title)
    const files =
      matched.length <= 3
        ? matched.join(', ')
        : `${matched.slice(0, 3).join(', ')} and ${matched.length - 3} more`
    notes.push({
      kind: 'action',
      title: rule.title,
      detail: rule.detail !== undefined ? `${rule.detail} (${files})` : files,
      command: rule.command,
    })
  }
  return notes
}
