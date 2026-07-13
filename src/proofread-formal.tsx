/** Formal proofread command (no-view): also rewrite into a polished formal register. */

import { runProofread } from "./run-proofread";

export default async function Command(): Promise<void> {
  await runProofread(true);
}
