/** Owns a WebGL RGB texture, with a 2D fallback when WebGL cannot be acquired. */
export function createRgbCanvas(canvas: HTMLCanvasElement): {
  draw: (pixels: Uint8Array, width: number, height: number) => void
  dispose: () => void
} {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false
  })
  if (!gl) {
    return createRgbCanvas2d(canvas)
  }
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (!shader) {
      throw new Error('Could not create emulator shader')
    }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      throw new Error('Could not compile emulator shader')
    }
    return shader
  }
  const vertex = compile(
    gl.VERTEX_SHADER,
    'attribute vec2 position; varying vec2 uv; void main(){ gl_Position=vec4(position,0.0,1.0); uv=vec2((position.x+1.0)*0.5,(1.0-position.y)*0.5); }'
  )
  const fragment = compile(
    gl.FRAGMENT_SHADER,
    'precision mediump float; varying vec2 uv; uniform sampler2D image; void main(){ gl_FragColor=texture2D(image,uv); }'
  )
  const program = gl.createProgram()
  const texture = gl.createTexture()
  const buffer = gl.createBuffer()
  if (!program || !texture || !buffer) {
    throw new Error('Could not allocate emulator display')
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Could not link emulator display')
  }
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  let currentWidth = 0,
    currentHeight = 0
  return {
    draw: (pixels, width, height) => {
      if (gl.isContextLost()) {
        throw new Error('Emulator display context lost')
      }
      if (width !== currentWidth || height !== currentHeight) {
        currentWidth = canvas.width = width
        currentHeight = canvas.height = height
        gl.viewport(0, 0, width, height)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, pixels)
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGB, gl.UNSIGNED_BYTE, pixels)
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose: () => {
      gl.deleteBuffer(buffer)
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }
}

/** Expand RGB888 to opaque RGBA only for canvases without a usable WebGL context. */
function createRgbCanvas2d(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new Error('Could not create emulator display')
  }
  let image: ImageData | null = null
  return {
    draw: (pixels: Uint8Array, width: number, height: number) => {
      if (!image || image.width !== width || image.height !== height) {
        canvas.width = width
        canvas.height = height
        image = context.createImageData(width, height)
      }
      for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
        image.data[target] = pixels[source]
        image.data[target + 1] = pixels[source + 1]
        image.data[target + 2] = pixels[source + 2]
        image.data[target + 3] = 255
      }
      context.putImageData(image, 0, 0)
    },
    dispose: () => {
      image = null
    }
  }
}
