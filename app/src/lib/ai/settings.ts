import { getBoolean, setBoolean } from '../local-storage'
import { TokenStore } from '../stores/token-store'
import { getKeyForEndpoint } from '../auth'
import {
  AIModelId,
  AIModels,
  AIOutputLanguage,
  DefaultAIModel,
  IAIRequestOptions,
} from './types'

const enabledKey = 'ai-features-enabled'
const modelKey = 'ai-model'
const languageKey = 'ai-output-language'

/** The keychain entry the Anthropic API key is stored under */
const apiKeyKeychainService = getKeyForEndpoint('https://api.anthropic.com')
const apiKeyKeychainLogin = 'anthropic-api-key'

export interface IAISettings {
  readonly enabled: boolean
  readonly model: AIModelId
  readonly language: AIOutputLanguage
}

function isAIModelId(value: string | null): value is AIModelId {
  return AIModels.some(m => m.id === value)
}

export function getAISettings(): IAISettings {
  const model = localStorage.getItem(modelKey)
  const language = localStorage.getItem(languageKey)

  return {
    enabled: getBoolean(enabledKey, false),
    model: isAIModelId(model) ? model : DefaultAIModel,
    language: language === 'es' ? 'es' : 'en',
  }
}

export function setAISettings(settings: IAISettings) {
  setBoolean(enabledKey, settings.enabled)
  localStorage.setItem(modelKey, settings.model)
  localStorage.setItem(languageKey, settings.language)
}

/** Returns the API key stored in the OS keychain, or null if there's none */
export async function getAIApiKey(): Promise<string | null> {
  try {
    return await TokenStore.getItem(apiKeyKeychainService, apiKeyKeychainLogin)
  } catch (e) {
    log.error('AI: unable to read the API key from the keychain', e)
    return null
  }
}

/** Stores the API key in the OS keychain, or removes it when empty */
export async function setAIApiKey(apiKey: string) {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) {
    await TokenStore.deleteItem(apiKeyKeychainService, apiKeyKeychainLogin)
  } else {
    await TokenStore.setItem(
      apiKeyKeychainService,
      apiKeyKeychainLogin,
      trimmed
    )
  }
}

export async function getAIRequestOptions(): Promise<IAIRequestOptions> {
  const { model, language } = getAISettings()
  return { apiKey: await getAIApiKey(), model, language }
}
