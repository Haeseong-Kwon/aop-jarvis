// Engineering-instrument text for the HUD: tiny monospaced labels rendered to canvas textures.
// Labels are flat planes in the scene (they take part in parallax), not DOM overlays.
import * as THREE from 'three'

const FONT = '500 {px}px "SF Mono", ui-monospace, Menlo, Consolas, monospace'

export class HudLabel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private text = ''

  /** `height` in orb units; `align` anchors the plane's left, centre, or right edge at the position. */
  constructor(
    text: string,
    private readonly height: number,
    private readonly align: 'left' | 'center' | 'right' = 'center',
    private readonly spacing = 0.18,
  ) {
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    this.mesh.userData.orb = 'hide'
    this.set(text)
  }

  set(text: string): void {
    if (text === this.text) return
    this.text = text
    const px = 40
    const font = FONT.replace('{px}', String(px))
    this.ctx.font = font
    const glyphs = [...text]
    const advance = glyphs.map((g) => this.ctx.measureText(g).width + px * this.spacing)
    const w = Math.max(1, Math.ceil(advance.reduce((a, b) => a + b, 0)))
    const h = Math.ceil(px * 1.3)
    this.canvas.width = w
    this.canvas.height = h
    this.ctx.font = font
    this.ctx.textBaseline = 'middle'
    this.ctx.fillStyle = '#ffffff'
    let x = 0
    glyphs.forEach((g, i) => {
      this.ctx.fillText(g, x, h / 2)
      x += advance[i]!
    })
    this.texture.dispose()
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.mesh.material.map = this.texture
    this.mesh.material.needsUpdate = true
    const aspect = w / h
    const geo = new THREE.PlaneGeometry(this.height * aspect, this.height)
    const shift = this.align === 'left' ? (this.height * aspect) / 2 : this.align === 'right' ? -(this.height * aspect) / 2 : 0
    geo.translate(shift, 0, 0)
    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
  }

  setColor(c: THREE.Color, alpha: number): void {
    this.mesh.material.color.copy(c).multiplyScalar(alpha)
  }

  dispose(): void {
    this.texture.dispose()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
