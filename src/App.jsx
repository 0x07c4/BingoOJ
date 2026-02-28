import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfListProblems } from "./oj/codeforces";
import ReactMarkdown from "react-markdown";
import Editor from "@monaco-editor/react";
import "./App.css";

console.log("BingoOJ App.jsx loaded v1");

const PROBLEM_LIST_CACHE_KEY = "bingooj:cf:list:v1";
const STATEMENT_CACHE_KEY = "bingooj:cf:statement:v1";
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

export default function App() {
  const [selectedId, setSelectedId] = useState("");
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState("");

  const [lang, setLang] = useState("cpp");
  const [drafts, setDrafts] = useState(() =>
    Object.fromEntries(
      Object.entries(LANGUAGES).map(([key, config]) => [key, config.template])
    )
  );
  const [stdin, setStdin] = useState("8\n");
  const [output, setOutput] = useState("Ready.");
  const [seededProblemId, setSeededProblemId] = useState("");
  const [selectedSampleIndex, setSelectedSampleIndex] = useState(0);
  const [sampleResults, setSampleResults] = useState([]);

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
  const currentLanguage = LANGUAGES[lang];
  const code = drafts[lang] ?? currentLanguage.template;
  const samples = problem?.samples ?? [];
  const selectedSample = samples[selectedSampleIndex] ?? null;
  const selectedResult =
    sampleResults.find((result) => result.index === selectedSampleIndex) ?? null;
  const passedSamples = sampleResults.filter((result) => result.ok).length;

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
    if (!problem?.id || seededProblemId === problem.id) return;

    const sampleInput = problem.samples?.[0]?.input;
    if (!sampleInput) return;

    setStdin(sampleInput);
    setSelectedSampleIndex(0);
    setSampleResults([]);
    setSeededProblemId(problem.id);
  }, [problem?.id, problem?.samples, seededProblemId]);

  function updateCode(nextCode) {
    setDrafts((current) => ({
      ...current,
      [lang]: nextCode,
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
      setOutput(`Running ${currentLanguage.label}...`);
      const out = await executeCode(stdin);
      setOutput(String(out));
    } catch (e) {
      setOutput(String(e));
    }
  }

  async function runSamples() {
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
    setSelectedSampleIndex(index);
    setStdin(sample.input);
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">BingoOJ</div>

        {loading && <div style={{ opacity: 0.7 }}>Loading Codeforces</div>}
        {err && (<div style={{ color: "salmon", whiteSpace: "pre-wrap" }}>{err}</div>)}

        <div className="list">
          {problems.map((p) => (
            <button
              key={p.id}
              className={"item " + (p.id === selectedId ? "active" : "")}
              onClick={() => setSelectedId(p.id)}
              title={p.id}
            >
              <div className="title">{p.title}</div>
              <div className="meta">
                {p.source} · {p.id}
                {p.rating ? ` . ${p.rating}` : ""}
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
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="cpp">C++</option>
              <option value="py">Python</option>
              <option value="js">JavaScript</option>
            </select>
            <button className="btn" onClick={runOnce}
            >
              Run
            </button>
            <button className="btn primary" onClick={() => setOutput("Submit (todo)")}>
              Submit
            </button>
            <button className="btn" onClick={runSamples}>
              Run Samples
            </button>
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
                <div className="sample-detail">
                  <div>
                    <div className="label">Sample Input</div>
                    <pre>{selectedSample.input}</pre>
                  </div>
                  <div>
                    <div className="label">Sample Output</div>
                    <pre>{selectedSample.output}</pre>
                  </div>
                </div>
              ) : null}
              {selectedResult ? (
                <div>
                  <div className="label">{selectedResult.error ? "Runtime Error" : "Your Output"}</div>
                  <pre>{selectedResult.error || selectedResult.got}</pre>
                </div>
              ) : null}
            </div>

            <div className="io-section">
              <div className="label">Stdin</div>
              <textarea
                value={stdin}
                onChange={(e) => setStdin(e.target.value)}
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
              <div className="label">Output</div>
              <pre className="out">{output}</pre>
            </div>
          </div>
        </section>
      </main>
    </div >
  );
}
