import { createHash } from "node:crypto";

const WORKFLOW_SHA256 =
  "32abad575c4ca05263814e626f7bdefe1b6c0ee05825e90054bbfb69f4db35f2";

export function validatePagesWorkflow(workflow, issues, filename) {
  const digest = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  if (digest !== WORKFLOW_SHA256)
    issues.push(
      `Pages workflow differs from its pinned source, candidate, qualification or maintenance contract in ${filename}`,
    );
}
