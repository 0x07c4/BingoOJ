import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfListProblems } from "./oj/codeforces";
import ReactMarkdown from "react-markdown";
import Editor from "@monaco-editor/react";
import "./App.css";

console.log("BingoOJ App.jsx loaded v1");

const MOCK = [
  {
    id: "CF-4A",
    title: "Watermelon",
    source: "Codeforces",
    statementMd: `# Watermelon

Given an integer **w**, determine if it can be split into **two even** positive integers.

**Input**: w  
**Output**: YES or NO

## Samples
`,
    samples: [
      { input: "8\n", output: "YES\n" },
      { input: "7\n", output: "NO\n" },
    ],
  },
  {
    id: "CF-71A",
    title: "Way Too Long Words",
    source: "Codeforces",
    statementMd: `# Way Too Long Words

Abbreviate words longer than 10.

Example: \`localization → l10n\`
`,
    samples: [{ input: "word\n", output: "w2d\n" }],
  },
];

export default function App() {
  const [selectedId, setSelectedId] = useState(MOCK[0].id);
  // const problem = useMemo(
  //   () => MOCK.find((p) => p.id === selectedId),
  //   [selectedId]
  // );
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [lang, setLang] = useState("cpp");
  const [code, setCode] = useState(`#include <bits/stdc++.h>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  // TODO
  return 0;
}
`);

  const [stdin, setStdin] = useState("8\n");
  const [output, setOutput] = useState("Ready.")

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const ps = await cfListProblems();
        if (!alive) return;
        const sliced = ps.slice(0, 200);
        setProblems(sliced);
        setSelectedId(sliced[0]?.id ?? "");
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

  async function runOnce() {
    if (lang !== "py") {
      setOutput("Run: 目前只支持 Python (py)。");
      return;
    }
    try {
      setOutput("Running...");
      const out = await invoke("run_python", { code, stdin });
      setOutput(String(out));
    } catch (e) {
      setOutput(String(e));
    }
  }

  async function runSamples() {
    if (lang !== "py") {
      setOutput("Run Samples: 目前只支持 Python（py）。");
      return;
    }
    setOutput("Running samples...");

    const samples = problem?.samples ?? [];
    if (samples.length === 0) {
      setOutput("No samples yet");
      return;
    }

    let report = "";
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      try {
        const out = await invoke("run_python", { code, stdin: s.input });
        const got = String(out).replace(/\r\n/g, "\n");
        const exp = String(s.output).replace(/\r\n/g, "\n");

        const ok = got.trimEnd() === exp.trimEnd();
        report += `#${i + 1} ${ok ? "✅" : "❌"}\n`;
        report += `Input:\n${s.input}\n`;
        report += `Expected:\n${s.output}\n`;
        report += `Got:\n${got}\n`;
        report += `${"-".repeat(40)}\n`;
      } catch (e) {
        report += `#${i + 1} ❌ (runtime error)\n${String(e)}\n${"-".repeat(40)}\n`;
      }
    }
    setOutput(report || "No samples.");
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
            <ReactMarkdown>{problem?.statementMd ?? ""}</ReactMarkdown>

            {problem?.url && (
              <p>
                <a href={problem.url} target="_blank" rel="noreferrer">
                  Open in browser
                </a>
              </p>
            )}

            {problem?.tags?.length ? (
              <p style={{ opacity: 0.8 }}>
                Tags: {problem.tags.join(", ")}
              </p>
            ) : null}
          </div>

          <div className="panel editor">
            <Editor
              height="100%"
              defaultLanguage="python"
              // defaultLanguage={lang === "cpp" ? "cpp" : lang === "py" ? "python" : "javascript"}
              value={code}
              onChange={(v) => setCode(v ?? "")}
              theme="vs-dark"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
            />
          </div>

          <div className="panel output">
            <div className="label">Stdin</div>
            <textarea
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              style={{
                width: "100%",
                height: 100,
                borderRadius: 12,
                border: "1px solid #232323",
                background: "#0e0e0e",
                color: "inherit",
                padding: 10,
              }}
            />
            <div className="label" style={{ marginTop: 10 }}>Output</div>
            <pre className="out">{output}</pre>
          </div>
        </section>
      </main>
    </div >
  );
}
