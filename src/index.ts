import * as core from "@actions/core";
import { run } from "./run.js";

try {
  await run();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : "The Action failed unexpectedly.");
}
