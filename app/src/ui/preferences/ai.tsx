import * as React from 'react'
import { DialogContent } from '../dialog'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { TextBox } from '../lib/text-box'
import { Select } from '../lib/select'
import { AIModelId, AIModels, AIOutputLanguage } from '../../lib/ai/types'

interface IAIPreferencesProps {
  readonly enabled: boolean
  readonly apiKey: string
  readonly model: AIModelId
  readonly language: AIOutputLanguage
  readonly onEnabledChanged: (enabled: boolean) => void
  readonly onApiKeyChanged: (apiKey: string) => void
  readonly onModelChanged: (model: AIModelId) => void
  readonly onLanguageChanged: (language: AIOutputLanguage) => void
}

export class AI extends React.Component<IAIPreferencesProps> {
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
            with AI" to the commit form. When you use them, the conflicted file
            or the diff of the selected changes is sent to the Anthropic API.
            Nothing is applied or committed until you accept it.
          </p>
        </div>

        <div className="advanced-section">
          <h2>Anthropic API</h2>
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
      </DialogContent>
    )
  }

  private onEnabledChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.props.onEnabledChanged(event.currentTarget.checked)
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
