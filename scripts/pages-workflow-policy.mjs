import { createHash } from "node:crypto";

const WORKFLOW_SHA256 =
  "d9a6cea6d7488d43d4de2d74c5532393003e6f914efddb96d77548cb5127bb08";

export function validatePagesWorkflow(workflow, issues, filename) {
  const digest = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  if (digest !== WORKFLOW_SHA256)
    issues.push(
      `Pages workflow differs from its pinned source, candidate, qualification or maintenance contract in ${filename}`,
    );
}
