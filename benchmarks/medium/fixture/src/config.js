export function createConfig(overrides = {}) {
  return { retries: overrides.retries ?? 2 };
}
