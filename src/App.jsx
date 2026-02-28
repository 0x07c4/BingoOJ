import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfListProblems } from "./oj/codeforces";
import ReactMarkdown from "react-markdown";
import Editor from "@monaco-editor/react";
import "./App.css";

console.log("BingoOJ App.jsx loaded v1");

const PROBLEM_LIST_CACHE_KEY = "bingooj:cf:list:v1";
const STATEMENT_CACHE_KEY = "bingooj:cf:statement:v1";
const STATEMENT_TRANSLATION_CACHE_KEY = "bingooj:cf:translation:v3";
const DRAFT_CACHE_KEY = "bingooj:drafts:v1";
const PROBLEM_LIST_CACHE_MAX_AGE = 1000 * 60 * 30;
const STATEMENT_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 7;
const MATH_DELIMITER_PATTERN = /(\${1,3})([\s\S]+?)\1/g;
const MATH_SKIP_TAGS = new Set(["CODE", "KBD", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);
let katexRuntimePromise = null;

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

function readCachedStatementTranslation(problemId, lang) {
  const cached = readCache(STATEMENT_TRANSLATION_CACHE_KEY);
  const entry = cached?.[problemId]?.[lang];
  if (!entry?.savedAt || !entry?.value) return null;
  if (Date.now() - entry.savedAt > STATEMENT_CACHE_MAX_AGE) return null;
  return entry.value;
}

function writeCachedStatementTranslation(problemId, lang, value) {
  const cached = readCache(STATEMENT_TRANSLATION_CACHE_KEY) ?? {};
  const current = cached[problemId] ?? {};
  cached[problemId] = {
    ...current,
    [lang]: {
      savedAt: Date.now(),
      value,
    },
  };
  writeCache(STATEMENT_TRANSLATION_CACHE_KEY, cached);
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

async function loadKatexRuntime() {
  if (!katexRuntimePromise) {
    katexRuntimePromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([katexModule]) => katexModule.default);
  }

  return katexRuntimePromise;
}

function hasRenderableMath(rawHtml) {
  return typeof rawHtml === "string" && rawHtml.includes("$");
}

function normalizeStatementLabels(doc, language) {
  if (language !== "zh") return;

  const setText = (selector, text) => {
    const node = doc.querySelector(selector);
    if (node) node.textContent = text;
  };

  const setAllText = (selector, getText) => {
    doc.querySelectorAll(selector).forEach((node, index) => {
      node.textContent = getText(index);
    });
  };

  setText(".input-specification .section-title", "输入");
  setText(".output-specification .section-title", "输出");
  setText(".sample-tests .section-title", "示例");
  setText(".note .section-title", "说明");

  setAllText(".sample-test .input .title", () => "输入");
  setAllText(".sample-test .output .title", () => "输出");
}

function formatStatementHtml(rawHtml, katex, language) {
  if (!rawHtml || typeof window === "undefined") return rawHtml ?? "";

  const parser = new window.DOMParser();
  const doc = parser.parseFromString(rawHtml, "text/html");
  normalizeStatementLabels(doc, language);
  const walker = doc.createTreeWalker(doc.body, window.NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const node of textNodes) {
    const parent = node.parentElement;
    const text = node.textContent ?? "";
    if (!parent || !text.includes("$") || MATH_SKIP_TAGS.has(parent.tagName)) {
      continue;
    }

    MATH_DELIMITER_PATTERN.lastIndex = 0;
    if (!MATH_DELIMITER_PATTERN.test(text)) {
      continue;
    }

    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;

    text.replace(MATH_DELIMITER_PATTERN, (fullMatch, delimiter, formula, offset) => {
      if (offset > lastIndex) {
        fragment.append(doc.createTextNode(text.slice(lastIndex, offset)));
      }

      const textBefore = text.slice(0, offset).trim();
      const textAfter = text.slice(offset + fullMatch.length).trim();
      const isBlockLike =
        formula.includes("\n") ||
        ((textBefore.length === 0 && textAfter.length === 0) && formula.trim().length > 48);

      try {
        const rendered = katex.renderToString(formula.trim(), {
          displayMode: isBlockLike,
          throwOnError: false,
          strict: "ignore",
          trust: false,
        });
        const wrapper = doc.createElement(isBlockLike ? "div" : "span");
        wrapper.className = isBlockLike ? "cf-math-block" : "cf-math-inline";
        wrapper.innerHTML = rendered;
        fragment.append(wrapper);
      } catch {
        const fallback = doc.createElement(isBlockLike ? "div" : "span");
        fallback.className = isBlockLike
          ? "cf-math-block cf-math-block-fallback"
          : "cf-math-inline cf-math-inline-fallback";
        fallback.textContent = formula.trim();
        fragment.append(fallback);
      }

      lastIndex = offset + fullMatch.length;
      return fullMatch;
    });

    if (lastIndex < text.length) {
      fragment.append(doc.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, node);
  }

  return doc.body.innerHTML;
}

export default function App() {
  const [selectedId, setSelectedId] = useState("");
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState("");
  const [statementLanguage, setStatementLanguage] = useState("en");
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState("");
  const [translationSupport, setTranslationSupport] = useState({
    ready: false,
    installing: false,
    message: "Chinese statement support is not installed yet.",
  });
  const [translationInstall, setTranslationInstall] = useState({
    active: false,
    finished: false,
    ready: false,
    step: 0,
    total_steps: 4,
    phase: "Idle",
    error: "",
    logs: [],
  });
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
  const translatedStatementHtml =
    problem?.statementTranslations?.[statementLanguage] ?? null;
  const rawStatementHtml =
    statementLanguage === "zh" ? translatedStatementHtml : problem?.statement_html;
  const [displayedStatementHtml, setDisplayedStatementHtml] = useState(rawStatementHtml ?? "");

  useEffect(() => {
    let alive = true;
    const nextHtml = rawStatementHtml ?? "";

    if (!nextHtml) {
      setDisplayedStatementHtml("");
      return () => {
        alive = false;
      };
    }

    if (!hasRenderableMath(nextHtml)) {
      setDisplayedStatementHtml(formatStatementHtml(nextHtml, null, statementLanguage));
      return () => {
        alive = false;
      };
    }

    setDisplayedStatementHtml(nextHtml);
    (async () => {
      try {
        const katex = await loadKatexRuntime();
        if (!alive) return;
        setDisplayedStatementHtml(formatStatementHtml(nextHtml, katex, statementLanguage));
      } catch {
        if (!alive) return;
        setDisplayedStatementHtml(nextHtml);
      }
    })();

    return () => {
      alive = false;
    };
  }, [rawStatementHtml, statementLanguage]);

  async function refreshTranslationSupport() {
    try {
      const status = await invoke("get_translation_support_status", {
        fromLang: "en",
        toLang: "zh",
      });
      setTranslationSupport((current) => ({
        ...current,
        ready: Boolean(status?.ready),
        installing: false,
        message:
          typeof status?.message === "string"
            ? status.message
            : "Chinese statement support is not installed yet.",
      }));
    } catch (e) {
      setTranslationSupport((current) => ({
        ...current,
        ready: false,
        installing: false,
        message: String(e),
      }));
    }
  }

  useEffect(() => {
    writeCache(DRAFT_CACHE_KEY, problemDrafts);
  }, [problemDrafts]);

  useEffect(() => {
    refreshTranslationSupport();
  }, []);

  useEffect(() => {
    if (!translationInstall.active) return;

    let alive = true;
    const poll = async () => {
      try {
        const nextState = await invoke("get_translation_install_state");
        if (!alive) return;
        setTranslationInstall(nextState);
        if (nextState.finished) {
          await refreshTranslationSupport();
        }
      } catch (e) {
        if (!alive) return;
        setTranslationInstall((current) => ({
          ...current,
          active: false,
          finished: true,
          error: String(e),
        }));
      }
    };

    poll();
    const timer = window.setInterval(poll, 800);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [translationInstall.active]);

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
    setStatementLanguage("en");
    setTranslationLoading(false);
    setTranslationError("");
    setTranslationInstall({
      active: false,
      finished: false,
      ready: false,
      step: 0,
      total_steps: 3,
      phase: "Idle",
      error: "",
      logs: [],
    });
  }, [problem?.id]);

  useEffect(() => {
    if (statementLanguage !== "zh") return;
    if (!translationSupport.ready) return;
    if (statementLanguage !== "zh" || !problem?.id || !problem?.statement_html) return;
    if (problem.statementTranslations?.zh) return;

    const cachedTranslation = readCachedStatementTranslation(problem.id, "zh");
    if (cachedTranslation) {
      setProblems((current) =>
        current.map((item) =>
          item.id === problem.id
            ? {
              ...item,
              statementTranslations: {
                ...(item.statementTranslations ?? {}),
                zh: cachedTranslation,
              },
            }
            : item
        )
      );
      setTranslationError("");
      return;
    }

    let alive = true;
    (async () => {
      try {
        setTranslationLoading(true);
        setTranslationError("");
        const translatedHtml = await invoke("translate_problem_html", {
          html: problem.statement_html,
          fromLang: "en",
          toLang: "zh",
        });
        if (!alive) return;

        writeCachedStatementTranslation(problem.id, "zh", translatedHtml);
        setProblems((current) =>
          current.map((item) =>
            item.id === problem.id
              ? {
                ...item,
                statementTranslations: {
                  ...(item.statementTranslations ?? {}),
                  zh: translatedHtml,
                },
              }
              : item
          )
        );
      } catch (e) {
        if (!alive) return;
        setTranslationError(String(e));
      } finally {
        if (!alive) return;
        setTranslationLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [
    problem?.id,
    problem?.statementTranslations,
    problem?.statement_html,
    statementLanguage,
    translationSupport.ready,
  ]);

  async function installTranslationSupport() {
    try {
      setTranslationSupport((current) => ({
        ...current,
        installing: true,
        message: "Installing Chinese statement support...",
      }));
      setTranslationError("");
      const installState = await invoke("install_translation_support", {
        fromLang: "en",
        toLang: "zh",
      });
      setTranslationInstall(installState);
    } catch (e) {
      setTranslationSupport((current) => ({
        ...current,
        ready: false,
        installing: false,
        message: String(e),
      }));
      return;
    }

    setTranslationSupport((current) => ({
      ...current,
      installing: false,
    }));
  }

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
            <div className="statement-toolbar">
              <div className="statement-toolbar-copy">
                <div className="statement-kicker">Problem Statement</div>
                <div className="section-title">Statement</div>
                <div className="statement-meta-row">
                  <div className="statement-mode">
                    {statementLanguage === "zh"
                      ? "Chinese local translation"
                      : "Codeforces original"}
                  </div>
                  {samples.length ? (
                    <div className="statement-meta-muted">
                      {samples.length} sample{samples.length > 1 ? "s" : ""}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="statement-language-toggle">
                <button
                  className={
                    "statement-language-button " +
                    (statementLanguage === "en" ? "active" : "")
                  }
                  onClick={() => setStatementLanguage("en")}
                >
                  English
                </button>
                <button
                  className={
                    "statement-language-button " +
                    (statementLanguage === "zh" ? "active" : "")
                  }
                  onClick={() => setStatementLanguage("zh")}
                >
                  中文
                </button>
              </div>
            </div>
            {statementLoading ? (
              <div>Loading statement...</div>
            ) : statementError ? (
              <div style={{ color: "salmon", whiteSpace: "pre-wrap" }}>{statementError}</div>
            ) : statementLanguage === "zh" && !translationSupport.ready ? (
              <div className="statement-status">
                <div className="statement-status-title">Chinese statement support is not ready.</div>
                <div className="statement-status-detail">{translationSupport.message}</div>
                {translationInstall.active || translationInstall.finished ? (
                  <div className="install-progress">
                    <div className="install-progress-head">
                      <div className="install-phase">{translationInstall.phase}</div>
                      <div className="install-step">
                        Step {Math.min(
                          Math.max(translationInstall.step, translationInstall.active ? 1 : 0),
                          translationInstall.total_steps
                        )}
                        /{translationInstall.total_steps}
                      </div>
                    </div>
                    <div className="install-progress-bar">
                      <div
                        className="install-progress-fill"
                        style={{
                          width: `${Math.max(
                            8,
                            (Math.max(
                              translationInstall.step,
                              translationInstall.finished ? translationInstall.total_steps : 0
                            ) /
                              Math.max(translationInstall.total_steps, 1)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                    {translationInstall.logs?.length ? (
                      <div className="install-log">
                        {translationInstall.logs.map((line, index) => (
                          <div key={`install-log-${index}`}>{line}</div>
                        ))}
                      </div>
                    ) : null}
                    {translationInstall.error ? (
                      <div className="statement-status-detail">{translationInstall.error}</div>
                    ) : null}
                  </div>
                ) : null}
                <div className="statement-actions">
                  <button
                    className="btn primary"
                    onClick={installTranslationSupport}
                    disabled={translationSupport.installing || translationInstall.active}
                  >
                    {translationInstall.active || translationSupport.installing
                      ? "Installing..."
                      : "Set Up Chinese Statement Support"}
                  </button>
                  <button className="btn subtle" onClick={() => setStatementLanguage("en")}>
                    Use English Instead
                  </button>
                </div>
              </div>
            ) : statementLanguage === "zh" && translationLoading && !displayedStatementHtml ? (
              <div className="statement-status">Translating statement locally...</div>
            ) : statementLanguage === "zh" && translationError && !displayedStatementHtml ? (
              <div className="statement-status error">
                <div className="statement-status-title">Local translation failed.</div>
                <div className="statement-status-detail">{translationError}</div>
                <div className="statement-actions">
                  <button className="btn subtle" onClick={() => setStatementLanguage("en")}>
                    Back to English
                  </button>
                </div>
              </div>
            ) : displayedStatementHtml ? (
              <>
                {statementLanguage === "zh" && translationError ? (
                  <div className="statement-inline-note">
                    Local translation warning: {translationError}
                  </div>
                ) : null}
                <div className="statement-body">
                  <div
                    className="cf-statement"
                    dangerouslySetInnerHTML={{ __html: displayedStatementHtml }}
                  />
                </div>
              </>
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
