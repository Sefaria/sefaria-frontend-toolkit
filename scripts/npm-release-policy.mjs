import { createHash } from "node:crypto";

// Admission is for this exact caller, not a generic permission to publish.
const WORKFLOW_SHA256 =
  "451152f0ee79bf52500a9a4cb1c8682fd748a96951fad2d8e455f561172e5cd7";

export function validateNpmWorkflow(workflow) {
  const digest = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  return digest === WORKFLOW_SHA256
    ? []
    : [
        "Numbered npm workflow differs from its exact reviewed operation, source, approval, permission or artifact contract",
      ];
}
