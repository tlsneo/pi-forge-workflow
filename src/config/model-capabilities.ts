import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../runtime/types.js";

export function supportedThinkingLevelsForModel<TApi extends Api>(model: Model<TApi>): ThinkingLevel[] {
  if (!model.reasoning) return [];
  const reported = getSupportedThinkingLevels(model) as ThinkingLevel[];
  const explicitlyMapped = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, value]) => typeof value === "string")
    .map(([level]) => level);
  return [...new Set([...reported, ...explicitlyMapped])].filter((level) => level !== "off");
}
