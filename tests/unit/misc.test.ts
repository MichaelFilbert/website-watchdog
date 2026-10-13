import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { validateMonitorUrl } from '../../src/fetch/url-guard.js';
import { checkKey } from '../../src/jobs/scheduler.js';
import { classifyKey, webhookKey } from '../../src/jobs/handlers.js';
import { hashText } from '../../src/text/normalize.js';

describe('idempotency keys', () => {
  it('are deterministic per (monitor, snapshot hash) and distinct across them', () => {
    const h1 = hashText('page v1');
    const h2 = hashText('page v2');
    expect(classifyKey('m1', h1)).toBe(classifyKey('m1', h1));
    expect(classifyKey('m1', h1)).not.toBe(classifyKey('m1', h2));
    expect(classifyKey('m1', h1)).not.toBe(classifyKey('m2', h1));
    expect(webhookKey('c1')).toBe('webhook:c1');
    expect(checkKey('m1', 1000)).not.toBe(checkKey('m1', 2000));
  });
});

describe('validateMonitorUrl (SSRF guard)', () => {
  it.each(['https://example.com/pricing', 'http://shop.example.org:8080/a?b=1'])('allows %s', (url) => {
    expect(validateMonitorUrl(url, false).ok).toBe(true);
  });

  it.each([
    'ftp://example.com',
    'file:///etc/passwd',
    'not a url',
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.0.0.5/admin',
    'http://192.168.1.1',
    'http://172.20.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://user:pw@example.com',
  ])('rejects %s', (url) => {
    expect(validateMonitorUrl(url, false).ok).toBe(false);
  });

  it('allows loopback only when explicitly enabled', () => {
    expect(validateMonitorUrl('http://127.0.0.1:4000', true).ok).toBe(true);
  });
});

describe('loadConfig', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: '', LLM_PROVIDER: '' });
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.llmProvider).toBe('auto');
    expect(c.anthropicModel).toBe('claude-haiku-5-5');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'gpt' })).toThrow();
  });
});
