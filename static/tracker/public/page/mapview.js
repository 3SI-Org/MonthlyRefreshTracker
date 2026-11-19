/* Map view, zoomed to the eastern states where the clients are: a status bubble for each state in the release,
   upcoming states and leads from the roster, and DC magnified in an inset off the coast. */
(function () {
  const {h, fmtDay} = window.RTU;
  const W = 975, H = 610;
  const COLOR = {'Behind': 'var(--s-late)', 'Due soon': 'var(--risk-mod-fill)', 'On track': 'var(--s-done)', 'Complete': 'var(--s-done)', 'Not started': 'var(--g400)', 'Skipped': 'var(--g400)'};
  const label = (s) => (s.status === 'Behind' ? `${s.days_behind}d behind` : s.status);
  const bboxCache = new Map();
  const bbox = (row) => {
    if (!bboxCache.has(row.state)) {
      const n = (String(row.d).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]); }
      bboxCache.set(row.state, [x0, y0, x1, y1]);
    }
    return bboxCache.get(row.state);
  };

  dash.draw('map', {
    mount: (el) => {
      const svg = d3.select(el).append('svg').attr('class', 'rt-map-svg').attr('role', 'img')
        .attr('width', '100%').attr('height', '100%').attr('preserveAspectRatio', 'xMidYMid meet')
        .attr('aria-label', 'Map of the eastern US states with clients, colored by whether each is behind its schedule, with upcoming states and leads.');
      const clip = svg.append('defs').append('clipPath').attr('id', 'rt-dc-clip').append('circle');
      const base = svg.append('g');
      const layer = svg.append('g');
      const tip = h('div', {class: 'rt-tip', hidden: true});
      el.append(tip);
      return {svg, base, layer, tip, clip};
    },
    update: (el, {svg, base, layer, tip, clip}) => {
      el.querySelectorAll('.rt-fail').forEach((n) => n.remove());
      const G = dash.data('usmap'), S = dash.data('states'), R = dash.data('roster');
      if (G.status !== 'ok' || S.status !== 'ok') {
        layer.selectAll('*').remove();
        const loading = ['usmap', 'tickets', 'schedule', 'steps', 'lanes', 'states'].some((id) => dash.data(id).status === 'loading');
        if (!loading) el.prepend(h('p', {class: 'rt-fail', text: 'Failed to load'}));
        return;
      }
      const geo = new Map(G.data.map((r) => [r.state, r]));
      const rows = S.data.filter((s) => geo.has(s.state));
      const by = new Map(rows.map((s) => [s.state, s]));
      const extra = (R.status === 'ok' ? R.data : []).filter((r) => geo.has(r.state) && !by.has(r.state));
      const ex = new Map(extra.map((r) => [r.state, r]));

      // Zoom to the client states, with room for labels and the DC inset
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const st of [...by.keys(), ...ex.keys()]) {
        const b = bbox(geo.get(st));
        x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
      }
      if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
      const padX = (x1 - x0) * 0.1 + 20, padY = (y1 - y0) * 0.1 + 20;
      const vx = Math.max(0, x0 - padX), vy = Math.max(0, y0 - padY);
      const vw = Math.min(W, x1 + padX + 50) - vx, vh = Math.min(H, y1 + padY) - vy;
      svg.attr('viewBox', `${vx} ${vy} ${vw} ${vh}`);

      // k converts screen pixels to map units, so marks keep a readable size
      const cw = Math.max(1, el.clientWidth), ch = el.clientHeight || cw * vh / vw;
      const k = Math.max(0.25, Math.min(3.5, Math.max(vw / cw, vh / ch)));
      const ir = 30 * k;
      const dcRow = geo.get('DC');
      const dcY = dcRow ? (Number(dcRow.zoom_cy) || Number(dcRow.cy)) : vy + vh / 2;
      const INSET = {x: vx + vw - ir - 6 * k, y: Math.max(vy + ir + 4 * k, Math.min(vy + vh - ir - 18 * k, dcY + 55 * k)), r: ir, zoom: ir / 6};
      clip.attr('cx', INSET.x).attr('cy', INSET.y).attr('r', INSET.r - 1);

      const place = (e) => {
        const r = el.getBoundingClientRect();
        tip.hidden = false;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left - tw / 2, r.width - tw - 4))}px`;
        tip.style.top = `${e.clientY - r.top + 14}px`;
      };
      const showTip = (e, s) => {
        tip.replaceChildren(
          h('strong', {text: `${s.name} · ${label(s)}`}),
          RT.csLead && RT.csLead(s.state) ? h('div', {text: `CS lead: ${RT.csLead(s.state)}`}) : null,
          RT.noteFor && RT.noteFor(s.state) ? h('div', {text: `📌 ${RT.noteFor(s.state).text}`}) : null,
          s.status === 'Skipped' ? h('div', {text: `Skipped this month · ${s.skip_reason}`}) : h('div', {text: s.current_key ? `Now at ${s.current_step}` : s.current_step}),
          s.current_key ? h('div', {class: 'rt-muted', text: `${s.current_owner} · ${s.current_status} · due ${fmtDay(s.current_due)}`}) : null,
          h('div', {class: 'rt-muted', text: `${s.steps_closed} of ${s.steps_total} steps closed${s.tracks > 1 ? ' · also on Risk & Audit' : ''}`}));
        place(e);
      };
      const showExTip = (e, x) => {
        tip.replaceChildren(h('strong', {text: `${x.name || x.state} · ${x.short || x.stage}`}), h('div', {class: 'rt-muted', text: x.note || ''}), RT.csLead && RT.csLead(x.state) ? h('div', {text: `CS lead: ${RT.csLead(x.state)}`}) : null);
        place(e);
      };
      const hideTip = () => { tip.hidden = true; };

      base.selectAll('path').data(G.data, (d) => d.state).join('path')
        .attr('d', (d) => d.d)
        .attr('class', (d) => 'rt-map-state' + (RT.sel === d.state ? ' is-selected' : ''))
        .style('fill', (d) => (by.has(d.state) ? `color-mix(in srgb, ${COLOR[by.get(d.state).status] || 'var(--g400)'} 30%, #FFFFFF)`
          : ex.has(d.state) ? (ex.get(d.state).stage === 'Lead' ? '#FFFFFF' : 'color-mix(in srgb, var(--s-start) 22%, #FFFFFF)') : null))
        .style('stroke', (d) => (ex.has(d.state) && ex.get(d.state).stage === 'Lead' ? 'var(--g400)' : null))
        .style('stroke-dasharray', (d) => (ex.has(d.state) && ex.get(d.state).stage === 'Lead' ? `${3 * k} ${2 * k}` : null))
        .style('stroke-width', (d) => (ex.has(d.state) && ex.get(d.state).stage === 'Lead' ? 1.2 * k : null))
        .style('cursor', (d) => (by.has(d.state) ? 'pointer' : null))
        .on('click', (e, d) => { if (by.has(d.state)) RT.open(d.state); })
        .on('pointerenter pointermove', (e, d) => { if (by.has(d.state)) showTip(e, by.get(d.state)); else if (ex.has(d.state)) showExTip(e, ex.get(d.state)); else hideTip(); })
        .on('pointerleave', hideTip);

      layer.selectAll('*').remove();
      const labs = [], blocks = [], circles = [];
      for (const s of rows) {
        const g0 = geo.get(s.state);
        const color = COLOR[s.status] || 'var(--g400)';
        const g = layer.append('g').style('cursor', 'pointer')
          .on('click', () => RT.open(s.state))
          .on('pointerenter pointermove', (e) => showTip(e, s))
          .on('pointerleave', hideTip);
        let lx, ly;
        if (s.state === 'DC') {
          const cx = Number(g0.zoom_cx) || Number(g0.cx), cy = Number(g0.zoom_cy) || Number(g0.cy);
          const ang = Math.atan2(INSET.y - cy, INSET.x - cx);
          g.append('line').attr('class', 'rt-leader')
            .attr('x1', cx).attr('y1', cy)
            .attr('x2', INSET.x - Math.cos(ang) * INSET.r).attr('y2', INSET.y - Math.sin(ang) * INSET.r);
          g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 2.6 * k).style('fill', color);
          g.append('circle').attr('cx', INSET.x).attr('cy', INSET.y).attr('r', INSET.r).attr('class', 'rt-inset-bg');
          const z = g.append('g').attr('clip-path', 'url(#rt-dc-clip)')
            .append('g').attr('transform', `translate(${INSET.x},${INSET.y}) scale(${INSET.zoom}) translate(${-cx},${-cy})`);
          ['MD', 'VA'].forEach((a) => { if (geo.has(a)) z.append('path').attr('d', geo.get(a).d).attr('class', 'rt-inset-land'); });
          z.append('path').attr('d', g0.detail || g0.d).style('fill', color).style('fill-opacity', 0.9);
          g.append('circle').attr('cx', INSET.x).attr('cy', INSET.y).attr('r', INSET.r)
            .style('fill', 'none').style('stroke', color).style('stroke-width', 2 * k);
          g.append('text').attr('class', 'rt-inset-tag').attr('x', INSET.x).attr('y', INSET.y - INSET.r + 12 * k)
            .attr('text-anchor', 'middle').style('font-size', `${10 * k}px`).text('DC');
          lx = INSET.x; ly = INSET.y + INSET.r + 3 * k;
          blocks.push([INSET.x - INSET.r, INSET.y - INSET.r, INSET.x + INSET.r, INSET.y + INSET.r]);
          circles.push([INSET.x, INSET.y, INSET.r]);
          labs.push({x: INSET.x, y: INSET.y, r: INSET.r, t: null});
        } else {
          const x = Number(g0.cx), y = Number(g0.cy);
          const r = (11 + Math.min(s.days_behind, 14) * 0.5) * k;
          g.append('circle').attr('cx', x).attr('cy', y).attr('r', r)
            .style('fill', color).style('stroke', '#FFFFFF').style('stroke-width', 2 * k);
          g.append('text').attr('class', 'rt-bubble-code').attr('x', x).attr('y', y).attr('dy', '0.35em')
            .attr('text-anchor', 'middle').style('font-size', `${10.5 * k}px`).text(s.state);
          lx = x; ly = y + r + 2 * k;
          blocks.push([x - r, y - r, x + r, y + r]);
          circles.push([x, y, r]);
          labs.push({x, y, r, t: null});
        }
        labs[labs.length - 1].t = g.append('text').attr('class', 'rt-bubble-label').attr('x', lx).attr('y', ly).attr('dy', '0.9em')
          .attr('text-anchor', 'middle').style('font-size', `${11 * k}px`).style('stroke-width', `${3 * k}px`).text(label(s));
      }
      for (const x of extra) {
        const g0 = geo.get(x.state);
        const ox = Number(g0.cx), oy = Number(g0.cy), r = 9 * k;
        let cx = ox, cy = oy;
        // nudge away from a bubble it would touch, keeping a leader back to the state
        for (let pass = 0; pass < 3; pass++) {
          for (const [ax, ay, ar] of circles) {
            const dx = cx - ax, dy = cy - ay, dist = Math.hypot(dx, dy) || 0.01, need = ar + r + 3 * k;
            if (dist < need) { cx = ax + (dx / dist) * need; cy = ay + (dy / dist) * need; }
          }
        }
        circles.push([cx, cy, r]);
        const lead = x.stage === 'Lead';
        const g = layer.append('g').on('pointerenter pointermove', (e) => showExTip(e, x)).on('pointerleave', hideTip);
        if (Math.hypot(cx - ox, cy - oy) > r * 0.6) g.append('line').attr('class', 'rt-leader').attr('x1', ox).attr('y1', oy).attr('x2', cx).attr('y2', cy);
        g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', r)
          .style('fill', lead ? '#FFFFFF' : 'var(--s-start)').style('stroke', lead ? 'var(--g400)' : '#FFFFFF')
          .style('stroke-width', 1.5 * k).style('stroke-dasharray', lead ? `${3 * k} ${2 * k}` : null);
        g.append('text').attr('x', cx).attr('y', cy).attr('dy', '0.35em').attr('text-anchor', 'middle')
          .attr('class', lead ? 'rt-inset-tag' : 'rt-bubble-code').style('font-size', `${9 * k}px`).text(x.state);
        blocks.push([cx - r, cy - r, cx + r, cy + r]);
        labs.push({x: cx, y: cy, r, t: g.append('text').attr('class', 'rt-bubble-label').attr('x', cx).attr('y', cy + r + 2 * k).attr('dy', '0.9em')
          .attr('text-anchor', 'middle').style('font-size', `${10.5 * k}px`).style('stroke-width', `${3 * k}px`).text(x.short || x.stage)});
      }
      // Keep labels off each other and off the bubbles: try below, above, right, then left; hide if none fits.
      const placed = [];
      // state codes and the DC tag are obstacles too
      layer.selectAll('text').filter(function () { return !this.classList.contains('rt-bubble-label'); }).each(function () {
        try { const b = this.getBBox(); if (b.width) placed.push([b.x - 1 * k, b.y, b.x + b.width + 1 * k, b.y + b.height]); } catch (e) { /* not rendered yet */ }
      });
      const own = (l) => (o) => !(o[0] === l.x - l.r && o[1] === l.y - l.r);
      for (const l of labs) {
        if (!l.t) continue;
        const node = l.t.node();
        const tries = [
          {x: l.x, y: l.y + l.r + 2 * k, a: 'middle', dy: '0.9em'},
          {x: l.x, y: l.y - l.r - 2 * k, a: 'middle', dy: '-0.25em'},
          {x: l.x + l.r + 3 * k, y: l.y, a: 'start', dy: '0.35em'},
          {x: l.x - l.r - 3 * k, y: l.y, a: 'end', dy: '0.35em'},
        ];
        let ok = false;
        for (const c of tries) {
          l.t.attr('x', c.x).attr('y', c.y).attr('text-anchor', c.a).attr('dy', c.dy).attr('display', null);
          let bb;
          try { bb = node.getBBox(); } catch (e) { bb = null; }
          if (!bb || !bb.width) { ok = true; break; }
          const box = [bb.x - 3 * k, bb.y - 2 * k, bb.x + bb.width + 3 * k, bb.y + bb.height + 2 * k];
          const others = [...blocks.filter(own(l)), ...placed];
          if (!others.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) { placed.push(box); ok = true; break; }
        }
        if (!ok) l.t.attr('display', 'none');
      }
    },
  });
})();
