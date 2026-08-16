export function createRequestPolicy(config) {
  return {
    describe(path) {
      return { path, retries: config.retries };
    },
  };
}
