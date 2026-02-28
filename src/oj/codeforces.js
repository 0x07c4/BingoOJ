export async function cfListProblems() {
  const url = "https://codeforces.com/api/problemset.problems";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Codeforces API failed: " + res.status);
  const data = await res.json();
  if (data.status !== "OK") throw new Error("Codeforces API error");
  // 把题目数组映射成 BingoOJ 的最小结构
  const problems = data.result.problems.map((p) => ({
    id: `CF-${p.contestId}-${p.index}`,
    title: p.name,
    source: "Codeforces",
    url: p.contestId ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : "",
    tags: p.tags ?? [],
    rating: p.rating ?? null,
    samples: [], // 先空着
    statementMd: `题面暂不抓取，打开链接：${p.contestId ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : ""}`,
  }));
  return problems;
}
