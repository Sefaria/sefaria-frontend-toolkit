import { createHash } from "node:crypto";

const WORKFLOW_SHA256 =
  "bc7db3fd161d23a5d5563a7ca6027c74846fd312b378ff48464e70ab6b867762";

export function validatePagesWorkflow(workflow, issues, filename) {
  const digest = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  if (digest !== WORKFLOW_SHA256)
    issues.push(
      `Pages workflow differs from its pinned source, candidate, qualification or maintenance contract in ${filename}`,
    );
}
