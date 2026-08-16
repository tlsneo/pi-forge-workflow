import { createRequestPolicy } from "./request-policy.js";

export function createClient(config) {
  const policy = createRequestPolicy(config);
  return {
    describeRequest(path) {
      return policy.describe(path);
    },
  };
}
