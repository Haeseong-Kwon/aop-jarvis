// Regenerates assets/aop-mark.svg from the Orb's geometry module (single source of truth).
import { writeFileSync } from 'node:fs'
import { markSvgPaths } from '../apps/desktop/src/orb/mark.ts'

const { a, o, p } = markSvgPaths()
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="150 300 700 350" width="700" height="350">
  <title>AOP mark (reconstructed from the AOP logo)</title>
  <g fill="#eef3ff" fill-rule="evenodd">
    <path d="${o}"/>
    <path d="${a}"/>
    <path d="${p}"/>
  </g>
</svg>
`
writeFileSync(new URL('../assets/aop-mark.svg', import.meta.url), svg)
console.log('wrote assets/aop-mark.svg')
