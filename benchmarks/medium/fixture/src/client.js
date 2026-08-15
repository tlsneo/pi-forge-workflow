export function createClient(config) {
  return {
    describeRequest(path) {
      return { path, retries: config.retries };
    },
  };
}
