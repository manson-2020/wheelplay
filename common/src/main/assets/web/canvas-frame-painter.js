// Optional WebGL upload path for Canvas video rendering, with a 2D fallback.
const restorableCanvases = new WeakSet();
export function createCanvasFramePainter(canvas, { webgl = false, onError = () => {} } = {}) {
  const gl = webgl && canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    // Recovery copies the last picture in a later task, before clearing it.
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw Object.assign(new Error('Canvas rendering unavailable'), { name: 'NotSupportedError' });
    return { backend: '2d', draw: (source, width, height) => context.drawImage(source, 0, 0, width, height), dispose() {} };
  }
  if (!restorableCanvases.has(canvas)) {
    // Keep restoration enabled even if draw notices loss and disposes the
    // painter before the browser dispatches its asynchronous loss event.
    canvas.addEventListener('webglcontextlost', event => event.preventDefault());
    restorableCanvases.add(canvas);
  }
  let program = null, buffer = null, texture = null, disposed = false, width = 0, height = 0;
  const shaders = [];
  const lost = event => {
    event.preventDefault(); // Permit restoration for a subsequent receiver retry.
    if (!disposed) onError(new Error('WebGL context lost'));
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', lost);
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  }
  try {
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('WebGL shader allocation failed');
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('WebGL shader compilation failed');
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error('WebGL program allocation failed');
    // Keep texel coordinates precise for high-resolution dashboard text.
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision > 0 ? 'highp' : 'mediump';
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying ${precision} vec2 uv;
      void main() {
        uv = position * vec2(0.5, -0.5) + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
      precision ${precision} float;
      varying ${precision} vec2 uv;
      uniform sampler2D frame;
      void main() { gl_FragColor = vec4(texture2D(frame, uv).rgb, 1.0); }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL program linking failed');
    buffer = gl.createBuffer(); texture = gl.createTexture();
    if (!buffer || !texture) throw new Error('WebGL buffer allocation failed');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    canvas.addEventListener('webglcontextlost', lost);
    return {
      backend: 'webgl', dispose,
      draw(source, w, h) {
        if (disposed || gl.isContextLost()) throw new Error('WebGL context lost');
        const resized = width !== w || height !== h;
        if (resized && (w > maxSize || h > maxSize)) throw Object.assign(new Error('Video exceeds WebGL texture size'), { name: 'NotSupportedError' });
        gl.viewport(0, 0, w, h);
        // Upload the browser-owned source directly, without JS pixel readback.
        // texImage2D also permits the browser's optimized video upload path.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // Check the first upload and size changes, not every steady-state frame.
        if (resized && gl.getError() !== gl.NO_ERROR) throw new Error('WebGL frame upload failed');
        width = w; height = h;
      },
    };
  } catch (error) { dispose(); throw error; }
}
