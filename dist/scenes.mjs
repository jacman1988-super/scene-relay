export function createSceneRenderer(canvas) {
  const context = canvas.getContext('2d');
  let scene = 'aurora', paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 960, height = 540, last = 0, frame;
  const stars = Array.from({ length: 45 }, (_, i) => ({ x: ((i * 137 + 83) % 997) / 997, y: ((i * 61 + 19) % 400) / 1000, size: i % 3 === 0 ? 1.7 : 1 }));
  function resize() {
    const box = canvas.getBoundingClientRect();
    width = Math.max(box.width, 1); height = Math.max(box.height, 1);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * ratio; canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); draw(last);
  }
  function gradient(top, bottom) { const value = context.createLinearGradient(0, 0, 0, height); value.addColorStop(0, top); value.addColorStop(1, bottom); context.fillStyle = value; context.fillRect(0, 0, width, height); }
  function hill(y, color, amplitude, phase) {
    context.fillStyle = color; context.beginPath(); context.moveTo(0, height);
    for (let x = 0; x <= width + 8; x += 8) context.lineTo(x, y + Math.sin(x / width * 6 + phase) * amplitude + Math.sin(x / width * 13 + phase) * amplitude / 3);
    context.lineTo(width, height); context.closePath(); context.fill();
  }
  function draw(time) {
    const t = paused ? 0 : time / 16000;
    if (scene === 'aurora') {
      gradient('#082e3a', '#42786e');
      context.fillStyle = '#c7f8df';
      for (const star of stars) { context.globalAlpha = .4 + .4 * Math.sin(t + star.x * 12); context.beginPath(); context.arc(width * star.x, height * star.y, star.size, 0, Math.PI * 2); context.fill(); }
      context.globalAlpha = 1;
      context.fillStyle = '#e6f4cb'; context.beginPath(); context.arc(width * .72, height * .31, height * .09, 0, Math.PI * 2); context.fill();
      for (let i = 0; i < 5; i++) { context.strokeStyle = `rgba(140,247,198,${.07 + i * .02})`; context.lineWidth = height * .045; context.beginPath(); context.moveTo(-20, height * (.22 + i * .03)); context.bezierCurveTo(width * .25, height * (.8 + Math.sin(t) * .04), width * .5, -height * .1, width * 1.1, height * .24); context.stroke(); }
      hill(height * .66, '#30655f', height * .09, 1.7); hill(height * .79, '#174b4c', height * .06, 3); hill(height * .94, '#0b343c', height * .04, 1);
    } else if (scene === 'cove') {
      gradient('#eeb99f', '#f7ddbc'); context.fillStyle = '#fff3d1'; context.beginPath(); context.arc(width * .65, height * .37, height * .12, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#678d96'; context.fillRect(0, height * .53, width, height);
      for (let i = 0; i < 16; i++) { const y = height * (.55 + i * .03); context.strokeStyle = i % 2 ? '#a6bcb1' : '#d0d0af'; context.globalAlpha = .55; context.lineWidth = 1 + i / 9; context.beginPath(); context.moveTo(width * .15 + Math.sin(i + t) * 15, y); context.bezierCurveTo(width * .4, y + 3, width * .6, y - 4, width * (.85 - i * .01), y); context.stroke(); } context.globalAlpha = 1;
      hill(height * .86, '#516d79', height * .09, 1); hill(height * .98, '#263f52', height * .03, 4);
      context.fillStyle = '#f3d5b5'; context.beginPath(); context.ellipse(width * .14, height * .8, width * .22, height * .05, -.12, 0, Math.PI * 2); context.fill();
    } else {
      gradient('#493d56', '#c88761'); context.fillStyle = '#f5d78e'; context.beginPath(); context.arc(width * .55, height * .5, height * .13, 0, Math.PI * 2); context.fill();
      hill(height * .7, '#705e68', height * .05, 2); hill(height * .86, '#493b50', height * .07, 3);
      for (let i = 0; i < 17; i++) { const x = width * i / 16; const h = height * (.19 + (i * 7 % 5) * .04); const y = height * (.9 + Math.sin(i) * .05); context.fillStyle = i % 2 ? '#2b3341' : '#303849'; context.beginPath(); context.moveTo(x, y - h); context.lineTo(x - h * .35, y); context.lineTo(x + h * .35, y); context.closePath(); context.fill(); }
      for (let i = 0; i < 12; i++) { context.fillStyle = '#ffd887'; context.globalAlpha = .3 + .35 * Math.sin(i + t * 5); context.beginPath(); context.arc(width * ((i * 83 % 100) / 100), height * (.7 + Math.sin(i) * .12) - Math.sin(t + i) * 5, 1.5, 0, Math.PI * 2); context.fill(); } context.globalAlpha = 1;
    }
  }
  function animate(time) { if (time - last > 33) { last = time; if (!paused) draw(time); } frame = requestAnimationFrame(animate); }
  const observer = new ResizeObserver(resize); observer.observe(canvas); frame = requestAnimationFrame(animate);
  return { setScene(id) { scene = id; draw(last); }, setPaused(value) { paused = value; draw(last); }, get paused() { return paused; }, destroy() { observer.disconnect(); cancelAnimationFrame(frame); } };
}
