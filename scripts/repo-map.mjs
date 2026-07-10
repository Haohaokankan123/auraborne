#!/usr/bin/env node
// repo-map.mjs — generates a self-contained HTML dashboard of the whole repo:
// worktrees, branches, PRs, commits, and per-file diffs (click a file → sidebar).
// Regenerate anytime:  node scripts/repo-map.mjs   → writes scripts/repo-map.html
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's canonical empty tree
// Field/record separators: control bytes safe in argv. NOT NUL (0x00) — NUL truncates the shell command.
const SEP = '\x1f'; // unit separator (between fields)
const REC = '\x1e'; // record separator (between commits)
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { return ''; } };
const shJSON = (cmd) => { const o = sh(cmd).trim(); if (!o) return null; try { return JSON.parse(o); } catch { return null; } };

// ---- worktrees -------------------------------------------------------------
function worktrees() {
  const out = sh('git worktree list --porcelain');
  const list = []; let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; list.push(cur); }
    else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached' && cur) cur.branch = '(detached)';
  }
  const root = list[0]?.path || '';
  for (const w of list) {
    w.name = w.path === root ? 'main checkout' : w.path.split('/').pop();
    w.rel = w.path === root ? w.path : w.path.replace(root + '/', '');
    w.subject = sh(`git log -1 --format=%s ${w.head}`).trim();
  }
  return list;
}

// ---- branches --------------------------------------------------------------
function branches() {
  const fmt = ['%(refname:short)', '%(objectname:short)', '%(subject)', '%(committerdate:iso8601)', '%(upstream:track)'].join(SEP);
  const rows = sh(`git for-each-ref --sort=-committerdate --format='${fmt}' refs/heads`).split('\n').filter(Boolean);
  return rows.map((r) => { const [name, sha, subject, date, track] = r.split(SEP); return { name, sha, subject, date, track: track || '' }; });
}

// ---- PRs (via gh) ----------------------------------------------------------
function prs() {
  const data = shJSON('gh pr list --state all --limit 100 --json number,title,state,headRefName,baseRefName,isDraft,createdAt,mergedAt,url,additions,deletions,changedFiles,author');
  return (data || []).sort((a, b) => b.number - a.number);
}

// ---- commits + per-file patches -------------------------------------------
function parsePatchByFile(patch) {
  const map = {};
  const parts = patch.split(/\ndiff --git /);
  for (let i = 0; i < parts.length; i++) {
    let chunk = parts[i];
    if (i === 0) { if (!chunk.startsWith('diff --git ')) continue; chunk = chunk.slice('diff --git '.length); }
    const firstNL = chunk.indexOf('\n');
    const header = chunk.slice(0, firstNL);
    const m = header.match(/ b\/(.+)$/);
    const file = m ? m[1] : header.split(' ')[0].replace(/^a\//, '');
    map[file] = 'diff --git ' + chunk;
  }
  return map;
}

function commits() {
  const fmt = ['%H', '%h', '%an', '%ad', '%s', '%P'].join(SEP);
  const raw = sh(`git log --all --date-order --pretty=format:'${fmt}${REC}' --date=format:'%Y-%m-%d %H:%M'`);
  const records = raw.split(REC).map((s) => s.replace(/^\n/, '')).filter((s) => s.trim());

  return records.map((rec) => {
    const [full, short, author, date, subject, parents] = rec.split(SEP);
    const parentList = (parents || '').trim().split(/\s+/).filter(Boolean);
    const base = parentList[0] || EMPTY_TREE;
    const numstat = sh(`git diff ${base} ${full} --numstat`).split('\n').filter(Boolean);
    const patchRaw = sh(`git diff ${base} ${full}`);
    const byFile = parsePatchByFile(patchRaw);
    const files = numstat.map((line) => {
      const [add, del, file] = line.split('\t');
      return {
        file,
        add: add === '-' ? 0 : parseInt(add, 10),
        del: del === '-' ? 0 : parseInt(del, 10),
        binary: add === '-',
        patch: byFile[file] || '',
      };
    });
    return {
      full, short, author, date, subject,
      isMerge: parentList.length > 1,
      parents: parentList.map((p) => p.slice(0, 7)),
      refs: sh(`git for-each-ref --points-at ${full} --format='%(refname:short)'`).split('\n').filter(Boolean),
      add: files.reduce((s, f) => s + f.add, 0),
      del: files.reduce((s, f) => s + f.del, 0),
      files,
    };
  });
}

// ---- assemble --------------------------------------------------------------
const data = {
  repo: sh('git rev-parse --show-toplevel').trim().split('/').pop() || 'repo',
  generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  currentBranch: sh('git rev-parse --abbrev-ref HEAD').trim(),
  worktrees: worktrees(),
  branches: branches(),
  prs: prs(),
  commits: commits(),
};

// ---------------------------------------------------------------------------
function renderHTML(d) {
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${d.repo} — Repo Map</title>
<style>${CSS}</style></head>
<body>
<div id="app"></div>
<script>const DATA=${json};</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0b0f17;--panel:#121826;--panel2:#0e1420;--line:#1e2838;--text:#e6edf6;--dim:#8ba0bd;
--add:#3fb950;--del:#f85149;--accent:#58a6ff;--accent2:#bc8cff;--amber:#f0b429;--green:#2ea043;--purple:#8957e5;}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:radial-gradient(1200px 700px at 85% -12%,#16203422,#0b0f17),var(--bg);color:var(--text);
font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
#app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.nav{border-right:1px solid var(--line);padding:26px 16px;position:sticky;top:0;height:100vh;background:var(--panel2)}
.nav .brand{font-size:19px;font-weight:800;letter-spacing:-.3px;margin-bottom:2px}
.nav .brand .dot{color:var(--accent2)}
.nav .meta{color:var(--dim);font-size:11.5px;margin-bottom:24px;line-height:1.5}
.nav a{display:flex;align-items:center;gap:9px;color:var(--dim);text-decoration:none;padding:9px 11px;
border-radius:9px;font-weight:600;font-size:13.5px;margin-bottom:3px;cursor:pointer}
.nav a .c{margin-left:auto;font-size:11px;color:var(--dim);background:var(--panel);border:1px solid var(--line);
padding:1px 7px;border-radius:20px}
.nav a:hover{background:var(--panel);color:var(--text)}
.nav a.active{background:linear-gradient(90deg,#1b2740,#141c2e);color:var(--text)}
.nav a.active .c{color:var(--accent)}
.main{padding:34px 40px 90px;max-width:1080px}
h1{font-size:27px;margin:0 0 3px;letter-spacing:-.4px}
.sub{color:var(--dim);margin:0 0 26px;font-size:13.5px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:1.3px;color:var(--dim);margin:34px 0 14px;font-weight:700}
.totrow{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.tot{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 18px;min-width:110px;flex:1}
.tot .n{font-size:23px;font-weight:800;letter-spacing:-.5px}
.tot .n.add{color:var(--add)}.tot .n.del{color:var(--del)}
.tot .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-top:2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px}
.card .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sha{font-family:ui-monospace,monospace;color:var(--accent);font-size:12.5px}
.badge{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:20px}
.badge.open{background:#0d2a17;color:#4ac26b;border:1px solid #1c5231}
.badge.merged{background:#241a3a;color:#b98cff;border:1px solid #45318a}
.badge.closed{background:#2a1416;color:#ff6b6b;border:1px solid #5a2226}
.badge.draft{background:#26210f;color:var(--amber);border:1px solid #5c4d18}
.badge.cur{background:#0e2a44;color:var(--accent);border:1px solid #1d4a72}
.badge.merge{background:#1a2233;color:var(--dim);border:1px solid var(--line)}
.pill{font-size:11px;color:var(--dim);background:var(--panel2);border:1px solid var(--line);padding:2px 8px;border-radius:20px}
.plusminus .a{color:var(--add);font-weight:700}.plusminus .d{color:var(--del);font-weight:700;margin-left:6px}
a.link{color:var(--accent);text-decoration:none}a.link:hover{text-decoration:underline}
.muted{color:var(--dim)}
.wt-path{font-family:ui-monospace,monospace;font-size:12px;color:var(--dim);word-break:break-all}
.timeline{position:relative;padding-left:24px}
.timeline:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:linear-gradient(var(--accent),var(--accent2))}
.commit{position:relative;margin-bottom:10px}
.commit>.dot{position:absolute;left:-24px;top:18px;width:12px;height:12px;border-radius:50%;
background:var(--panel);border:2px solid var(--accent);box-shadow:0 0 0 4px #0b0f17}
.commit.merge>.dot{border-color:var(--dim)}
.commit .chead{cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.commit .chead:hover .subj{color:var(--accent)}
.commit .subj{font-weight:600;font-size:14.5px}
.commit .cmeta{color:var(--dim);font-size:12px;margin-top:2px}
.commit .caret{color:var(--dim);transition:transform .15s;display:inline-block}
.commit.open .caret{transform:rotate(90deg)}
.files{display:none;margin:10px 0 6px;border-top:1px solid var(--panel2);padding-top:8px}
.commit.open .files{display:block}
.frow{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:5px 6px;border-radius:8px;cursor:pointer}
.frow:hover{background:var(--panel2)}
.frow .fn{font-family:ui-monospace,monospace;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frow .fn .st{font-size:9.5px;font-weight:800;padding:0 5px;border-radius:4px;margin-right:7px}
.frow .st.A{background:#0f2417;color:var(--add)}.frow .st.M{background:#0e2a44;color:var(--accent)}.frow .st.D{background:#2a1416;color:var(--del)}
.frow .stat{display:flex;align-items:center;gap:8px}
.frow .nums{font-family:ui-monospace,monospace;font-size:11px;min-width:74px;text-align:right;color:var(--dim)}
.frow .nums .a{color:var(--add)}.frow .nums .d{color:var(--del)}
.frow .track{width:90px;height:7px;border-radius:4px;background:var(--panel2);overflow:hidden;display:flex}
.frow .track .g{background:var(--add);height:100%}.frow .track .r{background:var(--del);height:100%}
.overlay{position:fixed;inset:0;background:#0006;opacity:0;pointer-events:none;transition:opacity .18s;z-index:40}
.overlay.show{opacity:1;pointer-events:auto}
.sidebar{position:fixed;top:0;right:0;height:100vh;width:min(760px,82vw);background:var(--panel2);
border-left:1px solid var(--line);transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);
z-index:50;display:flex;flex-direction:column;box-shadow:-20px 0 60px #0008}
.sidebar.show{transform:translateX(0)}
.sb-head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px}
.sb-head .fname{font-family:ui-monospace,monospace;font-size:13px;font-weight:600;word-break:break-all;flex:1}
.sb-head .sub2{color:var(--dim);font-size:11.5px;margin-top:3px}
.sb-close{cursor:pointer;color:var(--dim);font-size:22px;line-height:1;border:none;background:none;padding:2px 4px}
.sb-close:hover{color:var(--text)}
.sb-body{overflow:auto;flex:1;padding:0}
.diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre;min-width:100%}
.diff .ln{display:block;padding:0 16px}
.diff .ln.add{background:#0f2417;color:#7ee787}
.diff .ln.del{background:#2a1416;color:#ffa198}
.diff .ln.hunk{background:#0e2036;color:#7bb7ff;font-weight:600}
.diff .ln.meta{color:var(--dim)}
.diff .empty{padding:30px;color:var(--dim);text-align:center;font-family:inherit}
@media(max-width:820px){#app{grid-template-columns:1fr}.nav{position:static;height:auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.nav .meta{width:100%}.main{padding:24px 18px 80px}}
`;

const CLIENT_JS = String.raw`
const D = DATA;
const esc = (s)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const el = (h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild;};
const totAdd = D.commits.reduce((s,c)=>s+c.add,0), totDel = D.commits.reduce((s,c)=>s+c.del,0);
const openPRs = D.prs.filter(p=>p.state==='OPEN').length, mergedPRs = D.prs.filter(p=>p.state==='MERGED').length;

const SECTIONS = [
  {id:'overview', label:'Overview', icon:'◉', count:null},
  {id:'worktrees', label:'Worktrees', icon:'\u{1F333}', count:D.worktrees.length},
  {id:'branches', label:'Branches', icon:'⌥', count:D.branches.length},
  {id:'prs', label:'Pull Requests', icon:'⎇', count:D.prs.length},
  {id:'commits', label:'Commits', icon:'●', count:D.commits.length},
];

function renderDiff(patch){
  if(!patch) return '<div class="empty">No textual diff (binary or empty).</div>';
  const lines = patch.split('\n');
  let out = '';
  for(const l of lines){
    let cls='ctx';
    if(l.startsWith('@@')) cls='hunk';
    else if(l.startsWith('+')&&!l.startsWith('+++')) cls='add';
    else if(l.startsWith('-')&&!l.startsWith('---')) cls='del';
    else if(l.startsWith('diff --git')||l.startsWith('index ')||l.startsWith('+++')||l.startsWith('---')||l.startsWith('new file')||l.startsWith('deleted file')||l.startsWith('similarity')||l.startsWith('rename')) cls='meta';
    out += '<span class="ln '+cls+'">'+(esc(l)||' ')+'</span>';
  }
  return '<div class="diff">'+out+'</div>';
}

const overlay = el('<div class="overlay"></div>');
const sidebar = el('<div class="sidebar"><div class="sb-head"><div style="flex:1"><div class="fname"></div><div class="sub2"></div></div><button class="sb-close">×</button></div><div class="sb-body"></div></div>');
document.body.append(overlay, sidebar);
overlay.onclick = closeSidebar;
sidebar.querySelector('.sb-close').onclick = closeSidebar;
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeSidebar();});
function openFile(f, commit){
  sidebar.querySelector('.fname').textContent = f.file;
  const st = f.del===0? 'added' : f.add===0? 'removed' : 'modified';
  sidebar.querySelector('.sub2').innerHTML = st+' · <span style="color:var(--add)">+'+f.add+'</span> <span style="color:var(--del)">−'+f.del+'</span> · in '+commit.short+' — '+esc(commit.subject);
  sidebar.querySelector('.sb-body').innerHTML = renderDiff(f.patch);
  sidebar.querySelector('.sb-body').scrollTop = 0;
  overlay.classList.add('show'); sidebar.classList.add('show');
}
function closeSidebar(){ overlay.classList.remove('show'); sidebar.classList.remove('show'); }

const app = document.getElementById('app');
const nav = el('<div class="nav"></div>');
nav.append(el('<div class="brand">'+D.repo+'<span class="dot">.map</span></div>'));
nav.append(el('<div class="meta">'+D.commits.length+' commits · branch <b>'+D.currentBranch+'</b><br>generated '+D.generated+'</div>'));
for(const s of SECTIONS){
  const a = el('<a data-id="'+s.id+'"><span>'+s.icon+'</span><span>'+s.label+'</span>'+(s.count!=null?'<span class="c">'+s.count+'</span>':'')+'</a>');
  a.onclick=()=>show(s.id);
  nav.append(a);
}
const main = el('<div class="main"></div>');
app.append(nav, main);

function show(id){
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('active',a.dataset.id===id));
  main.innerHTML='';
  main.append(VIEWS[id]());
  window.scrollTo(0,0);
  location.hash = id;
}

const VIEWS = {
  overview(){
    const wrap = el('<div></div>');
    wrap.append(el('<h1>'+D.repo+' — Repo Map</h1>'));
    wrap.append(el('<p class="sub">A living map of every worktree, branch, pull request and commit. Click any file in a commit to see its exact diff.</p>'));
    wrap.append(el('<div class="totrow">'+
      card(D.worktrees.length,'worktrees')+card(D.branches.length,'branches')+
      card(openPRs+' / '+mergedPRs,'PRs open / merged')+card(D.commits.length,'commits')+
      card('+'+totAdd,'insertions','add')+card('−'+totDel,'deletions','del')+'</div>'));
    wrap.append(el('<h2>Latest on each worktree</h2>'));
    for(const w of D.worktrees){
      wrap.append(el('<div class="card"><div class="top"><span class="badge cur">'+esc(w.branch||'?')+'</span>'+
        '<span class="sha">'+w.head+'</span><span class="muted">'+esc(w.subject||'')+'</span></div>'+
        '<div class="wt-path" style="margin-top:6px">'+esc(w.rel)+'</div></div>'));
    }
    wrap.append(el('<h2>Open pull requests</h2>'));
    const open = D.prs.filter(p=>p.state==='OPEN');
    if(!open.length) wrap.append(el('<p class="muted">None open.</p>'));
    for(const p of open) wrap.append(prCard(p));
    return wrap;
  },
  worktrees(){
    const wrap = el('<div></div>');
    wrap.append(el('<h1>Worktrees</h1><p class="sub">Isolated working copies — each on its own branch, sharing one git history.</p>'));
    for(const w of D.worktrees){
      const isCur = w.branch===D.currentBranch;
      wrap.append(el('<div class="card"><div class="top">'+
        '<b>'+esc(w.name)+'</b>'+(isCur?'<span class="badge cur">current</span>':'')+
        '<span class="badge merge">'+esc(w.branch||'?')+'</span><span class="sha">'+w.head+'</span></div>'+
        '<div class="muted" style="margin:6px 0 4px">'+esc(w.subject||'')+'</div>'+
        '<div class="wt-path">'+esc(w.path)+'</div></div>'));
    }
    return wrap;
  },
  branches(){
    const wrap = el('<div></div>');
    wrap.append(el('<h1>Branches</h1><p class="sub">Local branches, newest activity first.</p>'));
    for(const b of D.branches){
      const cur = b.name===D.currentBranch;
      wrap.append(el('<div class="card"><div class="top">'+
        '<b class="mono">'+esc(b.name)+'</b>'+(cur?'<span class="badge cur">current</span>':'')+
        '<span class="sha">'+b.sha+'</span>'+(b.track?'<span class="pill">'+esc(b.track.replace(/[\[\]]/g,''))+'</span>':'')+
        '<span class="muted" style="margin-left:auto;font-size:12px">'+esc(b.date.slice(0,16))+'</span></div>'+
        '<div class="muted" style="margin-top:6px">'+esc(b.subject)+'</div></div>'));
    }
    return wrap;
  },
  prs(){
    const wrap = el('<div></div>');
    wrap.append(el('<h1>Pull Requests</h1><p class="sub">'+openPRs+' open · '+mergedPRs+' merged.</p>'));
    if(!D.prs.length) wrap.append(el('<p class="muted">No pull requests found (is gh authenticated?).</p>'));
    for(const p of D.prs) wrap.append(prCard(p, true));
    return wrap;
  },
  commits(){
    const wrap = el('<div></div>');
    wrap.append(el('<h1>Commits</h1><p class="sub">Every commit across all branches. Click a commit to expand its files, then a file to see the diff.</p>'));
    const tl = el('<div class="timeline"></div>');
    for(const c of D.commits) tl.append(commitNode(c));
    wrap.append(tl);
    return wrap;
  },
};

function card(n,l,cls){ return '<div class="tot"><div class="n '+(cls||'')+'">'+n+'</div><div class="l">'+l+'</div></div>'; }

function prCard(p){
  const st = p.state.toLowerCase();
  const badge = p.isDraft&&p.state==='OPEN' ? '<span class="badge draft">draft</span>' : '<span class="badge '+st+'">'+st+'</span>';
  return el('<div class="card"><div class="top">'+badge+
    '<b>#'+p.number+'</b> <span>'+esc(p.title)+'</span></div>'+
    '<div class="muted" style="margin-top:7px;font-size:12.5px"><span class="mono">'+esc(p.headRefName)+'</span> → <span class="mono">'+esc(p.baseRefName)+'</span>'+
    ' · <span class="plusminus"><span class="a">+'+(p.additions||0)+'</span><span class="d">−'+(p.deletions||0)+'</span></span>'+
    ' · '+(p.changedFiles||0)+' files · <a class="link" href="'+p.url+'" target="_blank">view on GitHub ↗</a></div></div>');
}

function commitNode(c){
  const node = el('<div class="commit'+(c.isMerge?' merge':'')+'"><div class="dot"></div></div>');
  const refBadges = c.refs.map(r=>'<span class="badge '+(r===D.currentBranch?'cur':'merge')+'">'+esc(r)+'</span>').join('');
  const head = el('<div class="chead"><span class="caret">›</span>'+
    '<span class="subj">'+esc(c.subject)+'</span>'+(c.isMerge?'<span class="badge merge">merge</span>':'')+refBadges+'</div>');
  const meta = el('<div class="cmeta"><span class="sha">'+c.short+'</span> · '+esc(c.author)+' · '+esc(c.date)+
    ' · <span class="plusminus"><span class="a">+'+c.add+'</span><span class="d">−'+c.del+'</span></span> · '+c.files.length+' files</div>');
  const files = el('<div class="files"></div>');
  const max = Math.max(1, ...c.files.map(x=>x.add+x.del));
  for(const f of c.files){
    const st = f.del===0? 'A' : f.add===0? 'D' : 'M';
    const w = 90*(f.add+f.del)/max;
    const gw = (f.add+f.del)? w*f.add/(f.add+f.del) : 0;
    const rw = w-gw;
    const row = el('<div class="frow"><div class="fn"><span class="st '+st+'">'+st+'</span>'+esc(f.file)+'</div>'+
      '<div class="stat"><span class="nums"><span class="a">+'+f.add+'</span> <span class="d">−'+f.del+'</span></span>'+
      '<span class="track"><span class="g" style="width:'+gw+'px"></span><span class="r" style="width:'+rw+'px"></span></span></div></div>');
    row.onclick=(e)=>{e.stopPropagation();openFile(f,c);};
    files.append(row);
  }
  node.append(head, meta, files);
  head.onclick=()=>node.classList.toggle('open');
  return node;
}

const start = (location.hash||'#overview').slice(1);
show(start && VIEWS[start] ? start : 'overview');
`;

// ---- run -------------------------------------------------------------------
const html = renderHTML(data);
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'repo-map.html');
writeFileSync(outPath, html);
console.log(`repo-map → ${outPath}`);
console.log(`  ${data.worktrees.length} worktrees · ${data.branches.length} branches · ${data.prs.length} PRs · ${data.commits.length} commits`);
