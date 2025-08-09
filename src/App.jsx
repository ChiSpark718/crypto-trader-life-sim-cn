import React, { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// 工具函数
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (n) => `${(n * 100).toFixed(2)}%`;

function rng(seed) {
  // 可复现实验用 PRNG（Mulberry32）
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r, mean = 0, sd = 1) {
  // Box-Muller
  const u1 = Math.max(r(), 1e-12);
  const u2 = r();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z0;
}

// 初始状态
const initialState = () => ({
  day: 1,
  equity: 10000,
  peakEquity: 10000,
  cashRate: 0,
  regime: "震荡", // 牛市 | 熊市 | 震荡
  health: 0.85,
  stress: 0.15,
  skill: 0.05,
  discipline: 0.5,
  wins: 0,
  losses: 0,
  history: [{ day: 1, equity: 10000 }],
  log: ["欢迎来到加密货币交易者人生模拟器。起始资金 $10,000。活下去，成长，或被市场教育……"],
});

// 规则参数（可在设置中调整）
const defaultRules = {
  makerFeePerSide: 0.0002, // 0.02%
  takerFeePerSide: 0.0006, // 0.06%
  useMaker: true,
  fundingMean: 0.00005, // 0.005%/日
  fundingSd: 0.0002,
  maintenance: 0.1, // 维持保证金（简化）
  maxLeverage: 50,
  blackSwanProb: 0.01, // 黑天鹅概率
  blackSwanImpact: -0.1, // -10%
  goodNewsProb: 0.008, // 利好概率
  goodNewsImpact: 0.06, // +6%
};

const regimes = {
  牛市: { mean: 0.003, sd: 0.02, fundBias: +1 },
  熊市: { mean: -0.003, sd: 0.02, fundBias: -1 },
  震荡: { mean: 0.0, sd: 0.015, fundBias: 0 },
};

const regimeTransitions = {
  牛市: { 牛市: 0.82, 震荡: 0.14, 熊市: 0.04 },
  熊市: { 熊市: 0.82, 震荡: 0.14, 牛市: 0.04 },
  震荡: { 震荡: 0.7, 牛市: 0.15, 熊市: 0.15 },
};

function pickTransition(r, from) {
  const p = regimeTransitions[from];
  const x = r();
  let accu = 0;
  for (const k of Object.keys(p)) {
    accu += p[k];
    if (x <= accu) return k;
  }
  return from;
}

export default function App() {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const rand = useMemo(() => rng(seed), [seed]);
  const [state, setState] = useState(initialState);
  const [rules, setRules] = useState(defaultRules);
  const [action, setAction] = useState({ side: "空仓", size: 0.3, lev: 5, stop: 0.02, take: 0.04 });
  const [useStop, setUseStop] = useState(true);
  const [useTake, setUseTake] = useState(false);
  const [note, setNote] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState("交易"); // 交易 | 学习 | 休息

  // 读存档
  useEffect(() => {
    const saved = localStorage.getItem("ctlife_save_cn");
    if (saved) {
      try {
        const obj = JSON.parse(saved);
        setSeed(obj.seed ?? seed);
        setState(obj.state ?? initialState());
        setRules(obj.rules ?? defaultRules);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    localStorage.setItem(
      "ctlife_save_cn",
      JSON.stringify({ seed, state, rules })
    );
  };

  const hardReset = () => {
    if (!confirm("确定要重开吗？")) return;
    setState(initialState());
    setSeed(Math.floor(Math.random() * 1e9));
  };

  const feePerSide = rules.useMaker ? rules.makerFeePerSide : rules.takerFeePerSide;

  const kpi = useMemo(() => {
    const n = state.wins + state.losses;
    const winRate = n ? state.wins / n : 0;
    const drawdown = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity : 0;
    return { n, winRate, drawdown };
  }, [state]);

  function simulateDay() {
    setState((s0) => {
      let s = { ...s0 };
      const act = mode === "交易" ? action : { side: "空仓", size: 0, lev: 1 };

      // 市场状态迁移
      const oldRegime = s.regime;
      const newRegime = pickTransition(rand, oldRegime);
      s.regime = newRegime;

      // 基础日收益（市场 + 技能微调）
      let rParams = regimes[newRegime];
      let dailyRet = normal(rand, rParams.mean + s.skill * 0.0015 * (act.side === "空仓" ? 0 : 1), rParams.sd);

      // 黑天鹅与利好
      if (rand() < rules.blackSwanProb) dailyRet += rules.blackSwanImpact;
      if (rand() < rules.goodNewsProb) dailyRet += rules.goodNewsImpact;

      // 资金费率（方向相关）
      const funding = normal(rand, rules.fundingMean * (rParams.fundBias || 0), rules.fundingSd);
      const fundCost = (act.side === "做多" ? +1 : act.side === "做空" ? -1 : 0) * funding;

      // 止损 / 止盈（近似）
      let realizedRet = dailyRet;
      if (act.side !== "空仓") {
        if (useStop && realizedRet < -action.stop) realizedRet = -action.stop;
        if (useTake && realizedRet > action.take) realizedRet = action.take;
      }

      // 强平（近似）
      let liquidated = false;
      if (act.side !== "空仓") {
        const liqMove = (1 - rules.maintenance) / act.lev;
        if ((act.side === "做多" && realizedRet <= -liqMove) || (act.side === "做空" && realizedRet >= liqMove)) {
          liquidated = true;
        }
      }

      const size = clamp(act.size, 0, 1);
      const lev = clamp(act.lev, 1, rules.maxLeverage);

      const notional = s.equity * size * lev;
      const roundTripFee = feePerSide * 2 * notional;
      const fundingFee = Math.abs(notional) * Math.abs(fundCost);

      let pnl = 0;
      let tradeDesc = "保持空仓。";

      if (mode === "学习") {
        const gain = clamp(0.01 + normal(rand, 0, 0.005), 0, 0.03);
        s.skill = clamp(s.skill + gain * (1 - s.skill), 0, 0.5);
        s.discipline = clamp(s.discipline + 0.02, 0, 1);
        s.stress = clamp(s.stress - 0.08, 0, 1);
        s.health = clamp(s.health + 0.02, 0, 1);
        tradeDesc = `学习市场。技能 +${fmt(gain * 100)} 基点，压力下降。`;
      } else if (mode === "休息") {
        s.stress = clamp(s.stress - 0.15, 0, 1);
        s.health = clamp(s.health + 0.08, 0, 1);
        s.discipline = clamp(s.discipline + 0.01, 0, 1);
        tradeDesc = `休息日。健康/压力恢复。`;
      } else if (act.side !== "空仓") {
        // 压力与健康对表现的惩罚
        const penalty = (0.10 * s.stress + 0.05 * (1 - s.health)) * (lev / rules.maxLeverage) * (1 - s.discipline);
        const adjRet = realizedRet - penalty;

        if (liquidated) {
          pnl = -s.equity * size; // 保证金归零
          tradeDesc = `被强平：${act.side} x${lev}`;
          s.losses += 1;
          s.stress = clamp(s.stress + 0.2, 0, 1);
          s.health = clamp(s.health - 0.05, 0, 1);
        } else {
          const gross = notional * adjRet * (act.side === "做多" ? 1 : -1);
          pnl = gross - roundTripFee - fundingFee;
          if (pnl >= 0) s.wins += 1; else s.losses += 1;
          tradeDesc = `${act.side} x${lev} 仓位 ${pct(size)} → 日收益 ${pct(adjRet)}；费用 $${fmt(roundTripFee + fundingFee)}`;
          s.stress = clamp(s.stress + (lev / rules.maxLeverage) * 0.03 + (pnl < 0 ? 0.05 : -0.03), 0, 1);
        }
      }

      // 结算
      const prevEq = s.equity;
      s.equity = Math.max(0, s.equity + pnl + s.equity * s.cashRate);
      s.peakEquity = Math.max(s.peakEquity, s.equity);
      s.day += 1;

      const delta = s.equity - prevEq;
      const pl = `${delta >= 0 ? "+" : ""}$${fmt(delta)} (${pct(delta / Math.max(prevEq, 1e-9))})`;

      // 叙事提示
      let narrative = "";
      if (liquidated) narrative = " 追加保证金失败。惨痛的学费。";
      else if (mode === "交易" && Math.abs(delta) > prevEq * 0.05) narrative = delta > 0 ? " 大赚的一天！" : " 残酷的回撤。";
      else if (mode !== "交易") narrative = " 投资自己同样会复利。";

      const line = `第 ${s.day - 1} 天 | 市况：${oldRegime}→${newRegime} | ${tradeDesc} | 当日盈亏 ${pl}.` + narrative;
      s.log = [line, ...(note ? ["日记：" + note] : []), ...s.log].slice(0, 200);
      s.history = [...s.history, { day: s.day, equity: Math.round(s.equity * 100) / 100 }].slice(-365);
      return s;
    });
  }

  const equityColor = state.equity >= 10000 ? "text-emerald-600" : "text-rose-600";

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto grid gap-4">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">加密货币交易者人生模拟器</h1>
            <p className="text-sm text-slate-600">一个关于合约交易者生存的小型人生模拟器 / 轻肉鸽。仅供娱乐，非投资建议。v0.1</p>
          </div>
          <div className="flex gap-2">
            <button className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300" onClick={save}>保存</button>
            <button className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300" onClick={() => setShowSettings((v) => !v)}>{showSettings ? "关闭设置" : "设置"}</button>
            <button className="px-3 py-2 rounded-xl bg-rose-100 hover:bg-rose-200" onClick={hardReset}>重开</button>
          </div>
        </header>

        {/* 关键指标 */}
        <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <KPI label="天数" value={state.day} />
          <KPI label="权益" value={`$${fmt(state.equity)}`} className={equityColor} />
          <KPI label="胜率" value={`${(kpi.winRate * 100).toFixed(0)}%`} />
          <KPI label="最大回撤" value={pct(kpi.drawdown)} />
          <KPI label="健康" value={pct(state.health)} bar barValue={state.health} />
          <KPI label="压力" value={pct(state.stress)} bar barValue={state.stress} negative />
        </section>

        {/* 权益曲线 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">权益曲线</h2>
            <span className="text-xs text-slate-500">市场状态：{state.regime}</span>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={state.history} margin={{ left: 12, right: 12, top: 8, bottom: 8 }}>
                <XAxis dataKey="day" hide />
                <YAxis domain={[0, "dataMax + 1000"]} tickFormatter={(v) => `$${v}`}/>
                <Tooltip formatter={(v) => `$${fmt(v)}`} labelFormatter={(l) => `第 ${l} 天`} />
                <ReferenceLine y={10000} strokeDasharray="3 3" />
                <Line type="monotone" dataKey="equity" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 操作区 */}
        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl shadow p-4 space-y-4">
            <h3 className="font-semibold">今天的安排</h3>
            <div className="flex gap-2">
              <TabButton on={() => setMode("交易")} active={mode === "交易"}>交易</TabButton>
              <TabButton on={() => setMode("学习")} active={mode === "学习"}>学习</TabButton>
              <TabButton on={() => setMode("休息")} active={mode === "休息"}>休息</TabButton>
            </div>

            {mode === "交易" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {(["空仓", "做多", "做空"]).map((s) => (
                    <button key={s} onClick={() => setAction((a) => ({ ...a, side: s }))}
                      className={`px-3 py-2 rounded-xl border ${action.side === s ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-100"}`}>
                      {s}
                    </button>
                  ))}
                </div>

                <Slider label={`仓位比例 ${pct(action.size)}`} value={action.size} onChange={(v) => setAction((a) => ({ ...a, size: v }))} min={0} max={1} step={0.01} />
                <Slider label={`杠杆 x${action.lev}`} value={action.lev} onChange={(v) => setAction((a) => ({ ...a, lev: Math.round(v) }))} min={1} max={rules.maxLeverage} step={1} />

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={useStop} onChange={(e) => setUseStop(e.target.checked)} /> 止损 {pct(action.stop)}
                  </label>
                  <Slider small value={action.stop} onChange={(v) => setAction((a) => ({ ...a, stop: v }))} min={0.005} max={0.2} step={0.005} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={useTake} onChange={(e) => setUseTake(e.target.checked)} /> 止盈 {pct(action.take)}
                  </label>
                  <Slider small value={action.take} onChange={(v) => setAction((a) => ({ ...a, take: v }))} min={0.01} max={0.4} step={0.005} />
                </div>
              </div>
            )}

            {mode !== "交易" && (
              <p className="text-sm text-slate-600">今天不交易。{mode === "学习" ? "你将提升技能与纪律，降低压力。" : "你将恢复健康并降低压力。"}</p>
            )}

            <textarea className="w-full mt-2 text-sm p-2 rounded-xl border" placeholder="给今天写一句交易日记（可选）" value={note} onChange={(e) => setNote(e.target.value)} />

            <button onClick={simulateDay} className="w-full py-3 rounded-2xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700">结束一天 →</button>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="font-semibold mb-2">统计</h3>
            <ul className="text-sm space-y-1">
              <li>市场状态：<b className="uppercase">{state.regime}</b></li>
              <li>技能（边际优势）：{pct(state.skill)}</li>
              <li>纪律：{pct(state.discipline)}</li>
              <li>胜/负：{state.wins}/{state.losses}</li>
              <li>历史最高权益：${fmt(state.peakEquity)}</li>
              <li>现金利率：{pct(state.cashRate)}</li>
              <li>手续费（单边）：{pct(feePerSide)}</li>
              <li>资金费率均值（符号取决于方向与市况）：{pct(rules.fundingMean)}</li>
            </ul>
          </div>

          <div className="bg-white rounded-2xl shadow p-4 flex flex-col">
            <h3 className="font-semibold mb-2">事件日志</h3>
            <div className="flex-1 overflow-auto max-h-64 pr-1">
              <ul className="text-xs space-y-2">
                {state.log.map((l, i) => (
                  <li key={i} className="border-b pb-2">{l}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {showSettings && (
          <div className="bg-white rounded-2xl shadow p-4 space-y-3">
            <h3 className="font-semibold">设置</h3>
            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div>
                <Slider label={`最大杠杆 x${rules.maxLeverage}`} value={rules.maxLeverage} onChange={(v) => setRules((r) => ({ ...r, maxLeverage: Math.round(v) }))} min={5} max={100} step={1} />
                <Slider label={`维持保证金 ${pct(rules.maintenance)}`} value={rules.maintenance} onChange={(v) => setRules((r) => ({ ...r, maintenance: v }))} min={0.02} max={0.2} step={0.005} />
              </div>
              <div>
                <Slider label={`挂单费/单边 ${pct(rules.makerFeePerSide)}`} value={rules.makerFeePerSide} onChange={(v) => setRules((r) => ({ ...r, makerFeePerSide: v }))} min={0} max={0.002} step={0.0001} />
                <Slider label={`吃单费/单边 ${pct(rules.takerFeePerSide)}`} value={rules.takerFeePerSide} onChange={(v) => setRules((r) => ({ ...r, takerFeePerSide: v }))} min={0} max={0.003} step={0.0001} />
                <label className="flex items-center gap-2 mt-2"><input type="checkbox" checked={rules.useMaker} onChange={(e) => setRules((r) => ({ ...r, useMaker: e.target.checked }))} /> 按挂单费计算</label>
              </div>
              <div>
                <Slider label={`资金费率均值 ${pct(rules.fundingMean)}`} value={rules.fundingMean} onChange={(v) => setRules((r) => ({ ...r, fundingMean: v }))} min={-0.001} max={0.001} step={0.00005} />
                <Slider label={`资金费率波动 ${pct(rules.fundingSd)}`} value={rules.fundingSd} onChange={(v) => setRules((r) => ({ ...r, fundingSd: v }))} min={0} max={0.0015} step={0.00005} />
                <Slider label={`黑天鹅概率 ${pct(rules.blackSwanProb)}`} value={rules.blackSwanProb} onChange={(v) => setRules((r) => ({ ...r, blackSwanProb: v }))} min={0} max={0.05} step={0.0005} />
                <Slider label={`黑天鹅冲击 ${pct(rules.blackSwanImpact)}`} value={rules.blackSwanImpact} onChange={(v) => setRules((r) => ({ ...r, blackSwanImpact: v }))} min={-0.5} max={0.2} step={0.01} />
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>随机种子：{seed}</span>
              <button className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>换一个种子</button>
            </div>
          </div>
        )}

        <footer className="text-xs text-slate-500 text-center py-4">仅供娱乐。市场有风险——请管理好风险。</footer>
      </div>
    </div>
  );
}

function KPI({ label, value, className, bar, barValue, negative }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${className || ""}`}>{value}</div>
      {bar && (
        <div className="mt-2 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`${negative ? "bg-rose-500" : "bg-emerald-500"} h-full`}
            style={{ width: `${Math.round(clamp(barValue, 0, 1) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({ children, on, active }) {
  return (
    <button onClick={on} className={`px-3 py-2 rounded-xl border ${active ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-100"}`}>
      {children}
    </button>
  );
}

function Slider({ label, value, onChange, min, max, step, small }) {
  return (
    <div className={`${small ? "grid grid-cols-2 items-center gap-2" : "space-y-1"}`}>
      {label && <div className={`text-sm ${small ? "text-right pr-2" : ""}`}>{label}</div>}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-slate-900" />
    </div>
  );
}
