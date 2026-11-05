import * as React from 'react'
import { DialogContent } from '../dialog'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { TextBox } from '../lib/text-box'
import { Select } from '../lib/select'
import { RadioGroup } from '../lib/radio-group'
import { Button } from '../lib/button'
import { LinkButton } from '../lib/link-button'
import {
  AIModelId,
  AIModels,
  AIOutputLanguage,
  AIProvider,
  IClaudeAccountStatus,
} from '../../lib/ai/types'
import { invoke } from '../../lib/ipc-renderer'

interface IAIPreferencesProps {
  readonly enabled: boolean
  readonly provider: AIProvider
  readonly apiKey: string
  readonly model: AIModelId
  readonly language: AIOutputLanguage
  readonly onEnabledChanged: (enabled: boolean) => void
  readonly onProviderChanged: (provider: AIProvider) => void
  readonly useProjectContext: boolean
  readonly onUseProjectContextChanged: (value: boolean) => void
  readonly safePull: boolean
  readonly onSafePullChanged: (value: boolean) => void
  readonly onApiKeyChanged: (apiKey: string) => void
  readonly onModelChanged: (model: AIModelId) => void
  readonly onLanguageChanged: (language: AIOutputLanguage) => void
}

interface IAIPreferencesState {
  /** null while checking */
  readonly accountStatus: IClaudeAccountStatus | null
  readonly isSigningIn: boolean
}

const providers: ReadonlyArray<AIProvider> = ['claude-account', 'api-key']

export class AI extends React.Component<
  IAIPreferencesProps,
  IAIPreferencesState
> {
  private unmounted = false

  public constructor(props: IAIPreferencesProps) {
    super(props)
    this.state = { accountStatus: null, isSigningIn: false }
  }

  public componentDidMount() {
    this.refreshAccountStatus()
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  public render() {
    const disabled = !this.props.enabled

    return (
      <DialogContent>
        <div className="advanced-section">
          <h2>AI assistant (Claude)</h2>
          <Checkbox
            label="Enable AI features"
            value={this.props.enabled ? CheckboxValue.On : CheckboxValue.Off}
            onChange={this.onEnabledChanged}
            ariaDescribedBy="ai-enabled-description"
          />
          <p id="ai-enabled-description" className="git-settings-description">
            Adds "Resolve with AI" to the merge conflicts dialog and "Generate
            with AI" to the commit form. When you use them, the conflicts or the
            diff of the selected changes are sent to Claude. Nothing is applied
            or committed until you accept it.
          </p>
        </div>

        <div className="advanced-section">
          <h2 id="ai-provider-heading">Connect with</h2>
          <RadioGroup<AIProvider>
            ariaLabelledBy="ai-provider-heading"
            selectedKey={this.props.provider}
            radioButtonKeys={providers}
            onSelectionChanged={this.props.onProviderChanged}
            renderRadioButtonLabelContents={this.renderProviderLabel}
          />
          {this.props.provider === 'claude-account'
            ? this.renderAccount()
            : this.renderApiKey(disabled)}
        </div>

        <div className="advanced-section">
          <Select
            label="Model"
            value={this.props.model}
            disabled={disabled}
            onChange={this.onModelChanged}
          >
            {AIModels.map(m => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>

          <Select
            label="Language for commit messages and explanations"
            value={this.props.language}
            disabled={disabled}
            onChange={this.onLanguageChanged}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </Select>
        </div>

        <div className="advanced-section">
          <h2>Project context</h2>
          <Checkbox
            label="Follow the project's own instructions"
            value={
              this.props.useProjectContext
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onUseProjectContextChanged}
            disabled={disabled}
            ariaDescribedBy="ai-project-context-description"
          />
          <p
            id="ai-project-context-description"
            className="git-settings-description"
          >
            Sends the repository's CLAUDE.md, AGENTS.md, review agents and
            commit conventions along with each request, so reviews, commit
            messages and conflict resolutions follow the team's rules.
          </p>
        </div>

        <div className="advanced-section">
          <h2>Flows</h2>
          <Checkbox
            label="Pull without losing local changes"
            value={this.props.safePull ? CheckboxValue.On : CheckboxValue.Off}
            onChange={this.onSafePullChanged}
            ariaDescribedBy="flows-safe-pull-description"
          />
          <p
            id="flows-safe-pull-description"
            className="git-settings-description"
          >
            The Pull button saves your uncommitted changes, pulls, brings them
            back (integrating any clash with AI) and tells you what to do next:
            run migrations, install dependencies, rebuild…
          </p>
        </div>
      </DialogContent>
    )
  }

  private renderProviderLabel = (provider: AIProvider) =>
    provider === 'claude-account'
      ? 'My Claude account (uses my Claude plan)'
      : 'Anthropic API key (pay per use)'

  private renderAccount() {
    const { accountStatus, isSigningIn } = this.state

    let status: JSX.Element
    if (isSigningIn) {
      status = (
        <p>
          Finish signing in in your browser. This window updates when you're
          done.
        </p>
      )
    } else if (accountStatus === null) {
      status = <p>Checking your Claude account…</p>
    } else if (accountStatus.kind === 'not-installed') {
      status = (
        <p>
          Connecting your account requires Claude Code.{' '}
          <LinkButton uri="https://claude.com/claude-code">
            Install Claude Code
          </LinkButton>
          , then come back here.{' '}
          <LinkButton onClick={this.refreshAccountStatus}>
            Check again
          </LinkButton>
        </p>
      )
    } else if (accountStatus.kind === 'logged-out') {
      status = (
        <>
          <p>Not signed in.</p>
          <Button onClick={this.onSignIn}>Sign in to Claude…</Button>
        </>
      )
    } else if (accountStatus.kind === 'logged-in') {
      const plan =
        accountStatus.plan !== null ? ` (${accountStatus.plan} plan)` : ''
      status = (
        <p>
          ✓ Connected as{' '}
          <strong>{accountStatus.email ?? 'your account'}</strong>
          {plan}.{' '}
          <LinkButton onClick={this.refreshAccountStatus}>Refresh</LinkButton>
        </p>
      )
    } else {
      status = (
        <>
          <p className="ai-account-error">{accountStatus.message}</p>
          <Button onClick={this.onSignIn}>Try again</Button>
        </>
      )
    }

    return (
      <div className="ai-account-status">
        {status}
        <p className="git-settings-description">
          Uses the Claude account you're signed in to in Claude Code, so
          requests count towards your Claude plan instead of API billing.
        </p>
      </div>
    )
  }

  private renderApiKey(disabled: boolean) {
    return (
      <>
        <TextBox
          label="API key"
          type="password"
          value={this.props.apiKey}
          placeholder="sk-ant-…"
          disabled={disabled}
          onValueChanged={this.props.onApiKeyChanged}
          ariaDescribedBy="ai-api-key-description"
        />
        <p id="ai-api-key-description" className="git-settings-description">
          Stored in your system keychain. If left empty, the ANTHROPIC_API_KEY
          environment variable is used.
        </p>
      </>
    )
  }

  private refreshAccountStatus = async () => {
    this.setState({ accountStatus: null })
    const accountStatus = await invoke('ai-claude-account-status')
    if (!this.unmounted) {
      this.setState({ accountStatus })
    }
  }

  private onSignIn = async () => {
    this.setState({ isSigningIn: true })
    const accountStatus = await invoke('ai-claude-account-login')
    if (!this.unmounted) {
      this.setState({ isSigningIn: false, accountStatus })
    }
  }

  private onEnabledChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.props.onEnabledChanged(event.currentTarget.checked)
  }

  private onUseProjectContextChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.props.onUseProjectContextChanged(event.currentTarget.checked)
  }

  private onSafePullChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.props.onSafePullChanged(event.currentTarget.checked)
  }

  private onModelChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const model = AIModels.find(m => m.id === value)
    if (model !== undefined) {
      this.props.onModelChanged(model.id)
    }
  }

  private onLanguageChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.props.onLanguageChanged(
      event.currentTarget.value === 'es' ? 'es' : 'en'
    )
  }
}
