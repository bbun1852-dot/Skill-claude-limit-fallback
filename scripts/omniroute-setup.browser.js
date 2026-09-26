// Run in a logged-in OmniRoute dashboard tab (http://localhost:20128/dashboard), e.g. with the
// Claude in Chrome javascript tool. The management API needs the dashboard session cookie.
// Creates or updates the "claude-fallback" combo and strips reasoning params from requests
// (without that, Mistral codestral rejects Claude Code with "reasoning_effort is not enabled").
(async () => {
  const COMBO = {
    name: 'claude-fallback',
    description: 'Claude limit fallback: free first, then paid',
    strategy: 'priority',
    models: [
      'mistral/codestral-latest',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/qwen/qwen3.8-27b:free',
      'gemini/gemini-3.8-flash',
      'groq/openai/gpt-oss-120b',
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.5',
      'moonshot/kimi-k2.7-code',
    ],
  };
  const call = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const { combos } = await call('GET', '/api/combos');
  const existing = combos.find((c) => c.name === COMBO.name);
  const saved = existing
    ? await call('PUT', `/api/combos/${existing.id}`, { description: COMBO.description, strategy: COMBO.strategy, models: COMBO.models })
    : await call('POST', '/api/combos', COMBO);
  const budget = await call('PUT', '/api/settings/thinking-budget', { mode: 'auto' });
  return `${existing ? 'updated' : 'created'} combo ${saved.name}: ${saved.models.map((m) => m.model).join(' > ')} | thinking-budget ${budget.mode}`;
})();
