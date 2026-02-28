import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfListProblems } from "./oj/codeforces";
import ReactMarkdown from "react-markdown";
import Editor from "@monaco-editor/react";
import "./App.css";

console.log("BingoOJ App.jsx loaded v1");

const PROBLEM_LIST_CACHE_KEY = "bingooj:cf:list:v1";
const STATEMENT_CACHE_KEY = "bingooj:cf:statement:v1";
const DRAFT_CACHE_KEY = "bingooj:drafts:v1";
const PROBLEM_LIST_CACHE_MAX_AGE = 1000 * 60 * 30;
const STATEMENT_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

const LANGUAGES = {
  cpp: {
    label: "C++",
    editorLanguage: "cpp",
    template: `#include <bits/stdc++.h>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  // TODO
  return 0;
}
`,
  },
  py: {
    label: "Python",
    editorLanguage: "python",
    template: `import sys


def solve() -> None:
    data = sys.stdin.read().strip().split()
    # TODO
    print(data)


if __name__ == "__main__":
    solve()
`,
  },
  js: {
    label: "JavaScript",
    editorLanguage: "javascript",
    template: `const fs = require("fs");

const input = fs.readFileSync(0, "utf8").trim();

function solve(raw) {
  // TODO
  console.log(raw);
}

solve(input);
`,
  },
};

function createLanguageDrafts() {
  return Object.fromEntries(
    Object.entries(LANGUAGES).map(([key, config]) => [key, config.template])
  );
}

function createProblemDraft(stdin = "") {
  return {
    lang: "cpp",
    drafts: createLanguageDrafts(),
    stdin,
    hasEditedStdin: false,
  };
}

function normalizeProblemDraft(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const lang = value.lang in LANGUAGES ? value.lang : "cpp";
  const rawDrafts = value.drafts && typeof value.drafts === "object" ? value.drafts : {};

  return {
    lang,
    drafts: Object.fromEntries(
      Object.entries(LANGUAGES).map(([key, config]) => [
        key,
        typeof rawDrafts[key] === "string" ? rawDrafts[key] : config.template,
      ])
    ),
    stdin: typeof value.stdin === "string" ? value.stdin : "",
    hasEditedStdin: Boolean(value.hasEditedStdin),
  };
}

function readDrafts() {
  const cached = readCache(DRAFT_CACHE_KEY);
  if (!cached || typeof cached !== "object") return {};

  return Object.fromEntries(
    Object.entries(cached)
      .map(([problemId, value]) => [problemId, normalizeProblemDraft(value)])
      .filter(([, value]) => value !== null)
  );
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures and continue with network data.
  }
}

function readFreshValue(key, maxAge) {
  const cached = readCache(key);
  if (!cached?.value || !cached?.savedAt) return null;
  if (Date.now() - cached.savedAt > maxAge) return null;
  return cached.value;
}

function readCachedStatement(problemId) {
  const cached = readCache(STATEMENT_CACHE_KEY);
  const entry = cached?.[problemId];
  if (!entry?.savedAt || !entry?.value) return null;
  if (Date.now() - entry.savedAt > STATEMENT_CACHE_MAX_AGE) return null;
  return entry.value;
}

function writeCachedStatement(problemId, value) {
  const cached = readCache(STATEMENT_CACHE_KEY) ?? {};
  cached[problemId] = {
    savedAt: Date.now(),
    value,
  };
  writeCache(STATEMENT_CACHE_KEY, cached);
}

function toComparableLines(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const trimmed = normalized.trimEnd();
  if (!trimmed) return [];
  return trimmed.split("\n");
}

function buildLineDiff(expected, got) {
  const expectedLines = toComparableLines(expected);
  const gotLines = toComparableLines(got);
  const rowCount = Math.max(expectedLines.length, gotLines.length);
  const rows = [];
  let firstMismatchLine = null;

  for (let i = 0; i < rowCount; i++) {
    const expectedLine = expectedLines[i] ?? "";
    const gotLine = gotLines[i] ?? "";
    const matches = expectedLine === gotLine;
    if (!matches && firstMismatchLine === null) {
      firstMismatchLine = i + 1;
    }
    rows.push({
      lineNumber: i + 1,
      expected: expectedLine,
      got: gotLine,
      matches,
    });
  }

  return {
    rows,
    firstMismatchLine,
  };
}

export default function App() {
  const [selectedId, setSelectedId] = useState("");
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState("");
  const [problemDrafts, setProblemDrafts] = useState(() => readDrafts());
  const [output, setOutput] = useState("Ready.");
  const [selectedSampleIndex, setSelectedSampleIndex] = useState(0);
  const [sampleResults, setSampleResults] = useState([]);
  const [workspaceMode, setWorkspaceMode] = useState("samples");

  useEffect(() => {
    const cachedProblems = readFreshValue(
      PROBLEM_LIST_CACHE_KEY,
      PROBLEM_LIST_CACHE_MAX_AGE
    );
    if (cachedProblems?.length) {
      setProblems(cachedProblems);
      setSelectedId((current) => current || cachedProblems[0]?.id || "");
      setLoading(false);
    }

    let alive = true;
    (async () => {
      try {
        if (!cachedProblems?.length) {
          setLoading(true);
        }
        setErr("");
        const ps = await cfListProblems();
        if (!alive) return;
        const sliced = ps.slice(0, 200);
        writeCache(PROBLEM_LIST_CACHE_KEY, {
          savedAt: Date.now(),
          value: sliced,
        });
        setProblems(sliced);
        setSelectedId((current) =>
          current && sliced.some((item) => item.id === current)
            ? current
            : sliced[0]?.id ?? ""
        );
      } catch (e) {
        if (!alive) return;
        setErr(String(e));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const problem = useMemo(
    () => problems.find((p) => p.id === selectedId),
    [problems, selectedId]
  );
  const currentDraft = problem?.id ? problemDrafts[problem.id] ?? null : null;
  const lang = currentDraft?.lang ?? "cpp";
  const currentLanguage = LANGUAGES[lang];
  const code = currentDraft?.drafts?.[lang] ?? currentLanguage.template;
  const stdin = currentDraft?.stdin ?? "";
  const samples = problem?.samples ?? [];
  const selectedSample = samples[selectedSampleIndex] ?? null;
  const selectedResult =
    sampleResults.find((result) => result.index === selectedSampleIndex) ?? null;
  const passedSamples = sampleResults.filter((result) => result.ok).length;
  const selectedDiff =
    selectedResult && !selectedResult.ok && !selectedResult.error
      ? buildLineDiff(selectedResult.expected, selectedResult.got)
      : null;

  useEffect(() => {
    writeCache(DRAFT_CACHE_KEY, problemDrafts);
  }, [problemDrafts]);

  useEffect(() => {
    if (!problem?.contestId || !problem?.index || problem.statement_html) return;

    const cachedStatement = readCachedStatement(problem.id);
    if (cachedStatement) {
      setProblems((current) =>
        current.map((item) =>
          item.id === problem.id
            ? {
              ...item,
              ...cachedStatement,
            }
            : item
        )
      );
      return;
    }

    let alive = true;
    (async () => {
      try {
        setStatementLoading(true);
        setStatementError("");
        const data = await invoke("cf_fetch_problem", {
          contestId: problem.contestId,
          index: problem.index,
        });
        if (!alive) return;

        writeCachedStatement(problem.id, data);
        setProblems((current) =>
          current.map((item) =>
            item.id === problem.id
              ? {
                ...item,
                ...data,
              }
              : item
          )
        );
      } catch (e) {
        if (!alive) return;
        setStatementError(String(e));
      } finally {
        if (!alive) return;
        setStatementLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [problem?.contestId, problem?.id, problem?.index, problem?.statement_html]);

  useEffect(() => {
    if (!problem?.id) return;

    const sampleInput = problem.samples?.[0]?.input ?? "";
    setProblemDrafts((current) => {
      const existing = current[problem.id];
      if (!existing) {
        return {
          ...current,
          [problem.id]: createProblemDraft(sampleInput),
        };
      }
      if (!existing.hasEditedStdin && !existing.stdin && sampleInput) {
        return {
          ...current,
          [problem.id]: {
            ...existing,
            stdin: sampleInput,
          },
        };
      }
      return current;
    });
  }, [problem?.id, problem?.samples]);

  useEffect(() => {
    setSelectedSampleIndex(0);
    setSampleResults([]);
    setOutput("Ready.");
    setWorkspaceMode("samples");
  }, [problem?.id]);

  function updateCurrentDraft(updater) {
    if (!problem?.id) return;

    setProblemDrafts((current) => {
      const existing =
        current[problem.id] ??
        createProblemDraft(problem.samples?.[0]?.input ?? "");
      return {
        ...current,
        [problem.id]: updater(existing),
      };
    });
  }

  function updateCode(nextCode) {
    updateCurrentDraft((current) => ({
      ...current,
      drafts: {
        ...current.drafts,
        [lang]: nextCode,
      },
    }));
  }

  async function executeCode(nextStdin) {
    return invoke("run_code", {
      lang,
      code,
      stdin: nextStdin,
    });
  }

  async function runOnce() {
    try {
      setSampleResults([]);
      setWorkspaceMode("custom");
      setOutput(`Running ${currentLanguage.label}...`);
      const out = await executeCode(stdin);
      setOutput(String(out));
    } catch (e) {
      setWorkspaceMode("custom");
      setOutput(String(e));
    }
  }

  async function runSamples() {
    setWorkspaceMode("samples");
    setOutput(`Running ${currentLanguage.label} samples...`);

    if (samples.length === 0) {
      setSampleResults([]);
      setOutput("No samples yet");
      return;
    }

    const results = [];
    let passed = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      try {
        const out = await executeCode(s.input);
        const got = String(out).replace(/\r\n/g, "\n");
        const exp = String(s.output).replace(/\r\n/g, "\n");

        const ok = got.trimEnd() === exp.trimEnd();
        if (ok) passed += 1;
        results.push({
          index: i,
          input: s.input,
          expected: s.output,
          got,
          ok,
          error: "",
        });
      } catch (e) {
        results.push({
          index: i,
          input: s.input,
          expected: s.output,
          got: "",
          ok: false,
          error: String(e),
        });
      }
    }
    const firstFailedIndex = results.findIndex((result) => !result.ok);
    setSampleResults(results);
    setSelectedSampleIndex(firstFailedIndex >= 0 ? firstFailedIndex : 0);
    setOutput(`Samples: ${passed}/${results.length} passed.`);
  }

  function loadSampleToStdin(index) {
    const sample = samples[index];
    if (!sample) return;
    setWorkspaceMode("samples");
    setSelectedSampleIndex(index);
    updateCurrentDraft((current) => ({
      ...current,
      stdin: sample.input,
      hasEditedStdin: true,
    }));
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">BingoOJ</div>
          <div className="sidebar-subtitle">Codeforces Problemset</div>
        </div>

        {loading && <div style={{ opacity: 0.7 }}>Loading Codeforces</div>}
        {err && (<div style={{ color: "salmon", whiteSpace: "pre-wrap" }}>{err}</div>)}

        <div className="list-head">
          <div className="list-title">Problems</div>
          <div className="list-count">{problems.length}</div>
        </div>
        <div className="list">
          {problems.map((p) => (
            <button
              key={p.id}
              className={"item " + (p.id === selectedId ? "active" : "")}
              onClick={() => setSelectedId(p.id)}
              title={p.id}
            >
              <div className="item-row">
                <div className="title">{p.title}</div>
                <div className="item-id">{p.index}</div>
              </div>
              <div className="meta">
                <span>{p.id}</span>
                {p.rating ? <span>{p.rating}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="hgroup">
            <div className="h1">{problem?.title}</div>
            <div className="h2">
              {problem?.source} · {problem?.id}
            </div>
          </div>

          <div className="controls">
            <div className="control-group">
              <div className="control-label">Language</div>
              <select
                value={lang}
                onChange={(e) => {
                  const nextLang = e.target.value;
                  updateCurrentDraft((current) => ({
                    ...current,
                    lang: nextLang,
                  }));
                }}
              >
                <option value="cpp">C++</option>
                <option value="py">Python</option>
                <option value="js">JavaScript</option>
              </select>
            </div>
            <div className="control-group actions">
              <div className="control-label">Actions</div>
              <div className="action-row">
                <button className="btn primary" onClick={runOnce}>
                  Run
                </button>
                <button
                  className="btn core"
                  disabled
                  title="Submit will be implemented next."
                >
                  Submit
                </button>
                <button className="btn subtle" onClick={runSamples}>
                  Run Samples
                </button>
              </div>
            </div>
          </div>
        </header>

        <section className="content">
          <div className="panel statement">
            {statementLoading ? (
              <div>Loading statement...</div>
            ) : statementError ? (
              <div style={{ color: "salmon", whiteSpace: "pre-wrap" }}>{statementError}</div>
            ) : problem?.statement_html ? (
              <div className="cf-statement"
                dangerouslySetInnerHTML={{ __html: problem.statement_html }}
              />
            ) : (
              <ReactMarkdown>{problem?.statementMd ?? ""}</ReactMarkdown>
            )}
          </div>

          <div className="panel editor">
            <Editor
              height="100%"
              language={currentLanguage.editorLanguage}
              value={code}
              onChange={(v) => updateCode(v ?? "")}
              theme="vs-dark"
              options={{
                automaticLayout: true,
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                scrollbar: {
                  alwaysConsumeMouseWheel: false,
                },
              }}
            />
          </div>

          <div className="panel output">
            <div className="workspace-tabs">
              <button
                className={"workspace-tab " + (workspaceMode === "samples" ? "active" : "")}
                onClick={() => setWorkspaceMode("samples")}
              >
                Samples
              </button>
              <button
                className={"workspace-tab " + (workspaceMode === "custom" ? "active" : "")}
                onClick={() => setWorkspaceMode("custom")}
              >
                Custom Test
              </button>
            </div>

            {workspaceMode === "samples" ? (
              <div className="sample-panel">
                <div className="sample-header">
                  <div>
                    <div className="section-title">Samples</div>
                    <div className="sample-subtitle">
                      {sampleResults.length > 0
                        ? `${passedSamples} / ${sampleResults.length} passed`
                        : `${samples.length} cases`}
                    </div>
                  </div>
                  {selectedResult ? (
                    <div className={"sample-inline-status " + (selectedResult.ok ? "pass" : "fail")}>
                      <span className="status-dot" />
                      <span>{selectedResult.ok ? "Passed" : "Failed"}</span>
                    </div>
                  ) : null}
                </div>
                {samples.length > 1 ? (
                  <div className="sample-tabs">
                    {samples.map((sample, index) => {
                      const result = sampleResults.find((item) => item.index === index);
                      return (
                        <button
                          key={`${problem?.id}-sample-${index}`}
                          className={"sample-tab " + (index === selectedSampleIndex ? "active" : "")}
                          onClick={() => loadSampleToStdin(index)}
                        >
                          <span className="sample-tab-title">Sample {index + 1}</span>
                          {result ? (
                            <span className={"sample-status " + (result.ok ? "pass" : "fail")}>
                              {result.ok ? "AC" : "WA"}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {selectedSample ? (
                  <div className="sample-meta">
                    <div className="sample-title">Sample {selectedSampleIndex + 1}</div>
                  </div>
                ) : null}
                {selectedSample ? (
                  <div className="sample-detail sample-detail-triple">
                    <div>
                      <div className="label">Input</div>
                      <pre>{selectedSample.input}</pre>
                    </div>
                    <div>
                      <div className="label">Expected Output</div>
                      <pre>{selectedSample.output}</pre>
                    </div>
                    <div>
                      <div className="label">{selectedResult?.error ? "Runtime Error" : "Got"}</div>
                      <pre>{selectedResult ? selectedResult.error || selectedResult.got : "Run Samples to evaluate this case."}</pre>
                    </div>
                  </div>
                ) : null}
                {selectedDiff ? (
                  <div className="diff-panel">
                    <div className="diff-summary">
                      First difference at line {selectedDiff.firstMismatchLine}.
                    </div>
                    <div className="diff-table">
                      <div className="diff-table-head">Expected</div>
                      <div className="diff-table-head">Got</div>
                      {selectedDiff.rows.map((row) => (
                        <Fragment key={`diff-row-${row.lineNumber}`}>
                          <div
                            className={"diff-cell " + (row.matches ? "" : "mismatch")}
                          >
                            <span className="diff-line-number">{row.lineNumber}</span>
                            <span className="diff-line-text">{row.expected || " "}</span>
                          </div>
                          <div
                            className={"diff-cell " + (row.matches ? "" : "mismatch")}
                          >
                            <span className="diff-line-number">{row.lineNumber}</span>
                            <span className="diff-line-text">{row.got || " "}</span>
                          </div>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                ) : !selectedResult ? (
                  <div className="sample-empty-state">
                    <div className="sample-empty-title">Run Samples to compare this case.</div>
                    <div className="sample-empty-body">
                      You will see the actual output and the first mismatch here.
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="custom-panel">
                <div className="custom-header">
                  <div>
                    <div className="section-title">Custom Test</div>
                    <div className="sample-subtitle">Edit input here, then use Run.</div>
                  </div>
                </div>
                <div className="custom-sections">
                  <div className="io-section">
                    <div className="io-header">
                      <div className="label">Input</div>
                    </div>
                    <textarea
                      value={stdin}
                      onChange={(e) => {
                        const nextStdin = e.target.value;
                        updateCurrentDraft((current) => ({
                          ...current,
                          stdin: nextStdin,
                          hasEditedStdin: true,
                        }));
                      }}
                      style={{
                        width: "100%",
                        height: "100%",
                        borderRadius: 12,
                        border: "1px solid #232323",
                        background: "#0e0e0e",
                        color: "inherit",
                        padding: 10,
                      }}
                    />
                  </div>
                  <div className="io-section">
                    <div className="io-header">
                      <div className="label">Output</div>
                    </div>
                    <pre className="out">{output}</pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div >
  );
}
