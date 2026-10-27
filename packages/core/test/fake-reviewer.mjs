// A reviewer command for tests: a blocker when the diff mentions "bug", a nit under FAKE_NIT, the model from FAKE_MODEL.
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (process.env.FAKE_DIE) {
    process.stderr.write("reviewer exploded\n");
    process.exit(3);
  }
  if (process.env.FAKE_GARBAGE) {
    console.log("not json");
    return;
  }
  const bad = /^\+.*bug/im.test(req.diff); // added lines only
  const findings = bad ? [{ severity: "blocker", file: "src.ts", line: 1, text: "This introduces a bug." }] : [];
  if (process.env.FAKE_NIT) findings.push({ severity: "nit", text: "Naming could be clearer." });
  console.log(JSON.stringify({ model: process.env.FAKE_MODEL ?? "fake-reviewer", verdict: "approve", summary: `Reviewed ${req.name} for: ${req.task} (${req.instructions.length} chars of instructions, env ${process.env.GRAFT_REVIEW}; commit ${req.commit ?? "none"}, base ${req.base ?? "none"})`, findings }));
});
