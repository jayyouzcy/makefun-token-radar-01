/* Token Radar — renders window.TOKEN_RADAR (written by main.ts) into a sortable,
   filterable board with a per-protocol detail view. No network: data.js is local. */
(function () {
  'use strict';
  var D = window.TOKEN_RADAR;
  var rows = D.rows.slice();
  var plans = D.plans;
  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', category: '', chain: '', minTvl: 0, sort: 'rank', watchOnly: false, sel: null };

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return '<span class="flat">—</span>';
    var c = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
    return '<span class="' + c + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return '<span class="flat">—</span>';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return d + 'd';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Fill the filter dropdowns from the data itself.
  var cats = {}, chains = {};
  rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    r.chains.forEach(function (c) { chains[c] = 1; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    $('category').appendChild(new Option(c, c));
  });
  Object.keys(chains).sort().forEach(function (c) {
    $('chain').appendChild(new Option(c, c));
  });

  // Header stats.
  var totalTvl = rows.reduce(function (a, r) { return a + r.tvl; }, 0);
  var watchRows = rows.filter(function (r) { return r.watchlist; });
  $('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b><span>protocols ranked</span></div>' +
    '<div class="stat"><b>' + watchRows.length + '</b><span>on the $50M watchlist</span></div>' +
    '<div class="stat"><b>' + fmtUsd(totalTvl) + '</b><span>combined TVL on the board</span></div>' +
    '<div class="stat"><b>' + fmtUsd(rows[0].implied) + '</b><span>top implied value · ' + esc(rows[0].name) + '</span></div>';
  $('asOf').textContent = D.asOf;
  $('source').textContent = D.source;

  function visible() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl < state.minTvl) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0)) return false;
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl - a.tvl;
      if (key === 'change7d') return (b.change7d === null ? -1e9 : b.change7d) - (a.change7d === null ? -1e9 : a.change7d);
      if (key === 'ageDays') return (b.ageDays === null ? -1 : b.ageDays) - (a.ageDays === null ? -1 : a.ageDays);
      return a.implied === b.implied ? a.tvl - b.tvl : b.implied - a.implied;
    });
    return list;
  }

  function render() {
    var list = visible();
    $('count').textContent = list.length + ' of ' + rows.length + ' shown';
    $('empty').hidden = list.length > 0;
    $('rows').innerHTML = list.map(function (r) {
      var rank = rows.indexOf(r) + 1;
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.sel === r.slug ? ' class="sel"' : '') + '>' +
        '<td>' + rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + (r.watchlist ? ' <span class="star" title="On the $50M watchlist">★</span>' : '') + '</b><small>' + esc(r.slug) + '</small></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + r.chains.slice(0, 3).map(esc).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl) + '</td>' +
        '<td class="num">' + fmtPct(r.change7d) + '</td>' +
        '<td class="num">' + fmtAge(r.ageDays) + '</td>' +
        '<td class="num"><b>' + fmtUsd(r.implied) + '</b></td></tr>';
    }).join('');
  }

  function showDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    state.sel = slug;
    var f = r.factors;
    var steps = (plans[slug] || []).map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(s) + '</li>';
    }).join('');
    $('detailBody').innerHTML =
      '<h2>' + esc(r.name) + (r.watchlist ? ' <span class="star">★ watchlist</span>' : '') + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + ' · ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ' · listed ' + (r.listedAt || 'date unknown') + '</p>' +
      '<div class="kv">' +
      '<div><b>' + fmtUsd(r.implied) + '</b><span>Implied value</span></div>' +
      '<div><b>' + fmtUsd(r.tvl) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.change7d === null ? '—' : (r.change7d > 0 ? '+' : '') + r.change7d.toFixed(1) + '%') + '</b><span>TVL change · 7d</span></div>' +
      '<div><b>' + fmtAge(r.ageDays) + '</b><span>Running with no token</span></div></div>' +
      '<p class="factors">Model: TVL × 0.42 × growth <b>' + f.growth + '</b> × age <b>' + f.age + '</b> × chains <b>' + f.chains + '</b> × category <b>' + f.category + '</b> = multiple <b>' + f.multiple + '×</b>. ' +
      'Chains: ' + r.chains.map(esc).join(', ') + '.</p>' +
      '<h3>How to farm it</h3><ol>' + steps + '</ol>' +
      '<p class="note">This protocol <b>records no token</b> in DefiLlama (no gecko_id, no symbol). That is what the record says — not proof it has no token, and not a promise one is coming.</p>';
    $('detail').hidden = false;
    document.querySelector('main').classList.add('with-detail');
    render();
  }

  function hideDetail() {
    state.sel = null;
    $('detail').hidden = true;
    document.querySelector('main').classList.remove('with-detail');
    render();
  }

  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) showDetail(tr.getAttribute('data-slug'));
  });
  $('closeDetail').addEventListener('click', hideDetail);

  // Column headers sort too: clicking a header picks that sort key.
  document.querySelectorAll('#board th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      state.sort = k === 'rank' || k === 'implied' ? 'rank' : k === 'name' || k === 'category' || k === 'chains' ? 'rank' : k;
      $('sort').value = state.sort;
      render();
    });
  });

  $('q').addEventListener('input', function () { state.q = this.value; render(); });
  $('category').addEventListener('change', function () { state.category = this.value; render(); });
  $('chain').addEventListener('change', function () { state.chain = this.value; render(); });
  $('minTvl').addEventListener('change', function () { state.minTvl = +this.value; render(); });
  $('sort').addEventListener('change', function () { state.sort = this.value; render(); });
  $('watchOnly').addEventListener('change', function () { state.watchOnly = this.checked; render(); });

  // Deep links for screenshots and sharing: #detail=<slug>&watchlist=1&category=<c>&q=<text>
  var hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('q')) { state.q = hash.get('q'); $('q').value = state.q; }
  if (hash.get('category')) { state.category = hash.get('category'); $('category').value = state.category; }
  if (hash.get('chain')) { state.chain = hash.get('chain'); $('chain').value = state.chain; }
  if (hash.get('minTvl')) { state.minTvl = +hash.get('minTvl'); $('minTvl').value = String(state.minTvl); }
  if (hash.get('sort')) { state.sort = hash.get('sort'); $('sort').value = state.sort; }
  if (hash.get('watchlist') === '1') { state.watchOnly = true; $('watchOnly').checked = true; }
  render();
  if (hash.get('detail')) showDetail(hash.get('detail'));
})();
