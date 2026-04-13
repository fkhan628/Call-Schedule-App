// DSG Call Schedule — Style Constants

const font = "'Outfit', sans-serif";
const mono = "'JetBrains Mono', monospace";

const css = {
  root: { fontFamily:font, background:"#f0f2f5", color:"#2c3e50", minHeight:"100vh" },
  hdr: { background:"linear-gradient(180deg,#ffffff,#f8f9fb)", borderBottom:"1px solid #dce2e8", padding:"14px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 },
  h1: { fontSize:21, fontWeight:700, color:"#1a2a3a", margin:0, letterSpacing:-0.5 },
  sub: { fontSize:11, color:"#7a8a98", margin:"2px 0 0", letterSpacing:0.8, textTransform:"uppercase" },
  nav: { display:"flex", gap:3, flexWrap:"wrap" },
  tab: a => ({ background:a?"#1a6fa8":"transparent", border:`1px solid ${a?"#1a6fa8":"#c8d0d8"}`, color:a?"#ffffff":"#6a7a88", borderRadius:7, padding:"5px 13px", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:font }),
  card: { background:"#ffffff", border:"1px solid #e0e4ea", borderRadius:10, padding:18, marginBottom:14, boxShadow:"0 1px 3px rgba(0,0,0,0.04)" },
  cardT: { fontSize:13, fontWeight:700, color:"#1a6fa8", margin:"0 0 12px", textTransform:"uppercase", letterSpacing:1.2 },
  inp: { background:"#f8f9fb", border:"1px solid #d0d8e0", borderRadius:5, padding:"6px 10px", color:"#2c3e50", fontSize:13, fontFamily:font, outline:"none" },
  btn: a => ({ background:a?"linear-gradient(135deg,#1a6fa8,#2488c8)":"#f0f2f5", border:`1px solid ${a?"#1a6fa8":"#c8d0d8"}`, color:a?"#ffffff":"#5a6a78", borderRadius:7, padding:"7px 16px", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:font }),
  badge: i => ({ display:"inline-flex", alignItems:"center", background:PAL[i%7].tg, color:PAL[i%7].tx, border:`1px solid ${PAL[i%7].bd}`, borderRadius:5, padding:"2px 9px", fontSize:12, fontWeight:600, whiteSpace:"nowrap", letterSpacing:0.3 }),
  appBadge: i => ({ display:"inline-flex", alignItems:"center", background:APP_PAL[i%4].tg, color:APP_PAL[i%4].tx, border:`1px solid ${APP_PAL[i%4].bd}`, borderRadius:5, padding:"2px 9px", fontSize:12, fontWeight:600, whiteSpace:"nowrap", letterSpacing:0.3 }),
  backupBanner: { background:"linear-gradient(90deg,#fef8e8,#fdf0d0)", border:"1px solid #e8d090", borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:700, color:"#8a6a10", letterSpacing:0.5 },
};

/* ═══════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════ */
