// run_code runs in the user's browser (sandboxed iframe): JavaScript natively, Python via Pyodide.
// The server pauses the agent, the page runs the code, then posts the output back to /api/chat/resume.
export const runCode = {
  name: "run_code",
  description:
    "Run JavaScript or Python code and get back its printed output, errors and return value. Use it to calculate, test code, check logic, process data, or verify an answer. To test code, include the code plus test cases/asserts and print the results. Python has numpy-free standard library only unless you import a Pyodide package (e.g. numpy, pandas) which loads automatically. No network or file access. Max ~20 seconds.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["javascript", "python"] },
      code: { type: "string" },
      purpose: { type: "string", description: "One short line shown to the user, e.g. 'Testing the sort function'" },
    },
    required: ["language", "code"],
  },
  client: true,
  scheduledOk: false,
  label: (a) => a.purpose || `Running ${a.language === "python" ? "Python" : "JavaScript"}`,
};
