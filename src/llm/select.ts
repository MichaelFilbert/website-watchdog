import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OllamaProvider, ollamaHasModel } from './ollama.js';
import type { LlmProvider } from './types.js';

/**
 * Picks the provider. With LLM_PROVIDER=auto: Anthropic if a key is set, else a local
 * Ollama that has the configured model, else the mock. The choice is always logged,
 * so nobody mistakes mock output for real model output.
 */
export async function selectProvider(config: Config, log: Logger): Promise<LlmProvider> {
  const wanted = config.llmProvider;

  if (wanted === 'anthropic' || (wanted === 'auto' && config.anthropicApiKey)) {
    if (!config.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
    log.info({ provider: 'anthropic', model: config.anthropicModel }, 'LLM provider: Anthropic');
    return AnthropicProvider.fromApiKey(config.anthropicApiKey, config.anthropicModel);
  }

  if (wanted === 'ollama' || wanted === 'auto') {
    if (wanted === 'ollama' || (await ollamaHasModel(config.ollamaUrl, config.ollamaModel))) {
      log.info({ provider: 'ollama', model: config.ollamaModel, url: config.ollamaUrl }, 'LLM provider: Ollama');
      return new OllamaProvider(config.ollamaModel, config.ollamaUrl);
    }
    log.warn(
      { ollamaUrl: config.ollamaUrl, model: config.ollamaModel },
      'No ANTHROPIC_API_KEY and Ollama is not reachable with that model; falling back to the MOCK provider',
    );
  }

  log.warn('LLM provider: MOCK (deterministic keyword heuristic, not a real model)');
  return new MockProvider();
}
