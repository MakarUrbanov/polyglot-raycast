/** Casual proofread command (no-view): fix mechanics, keep the author's register. */

import { runProofread } from "./run-proofread";

export default async function Command(): Promise<void> {
  await runProofread(false);
}
