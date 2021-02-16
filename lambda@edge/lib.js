const hash = require('object-hash')
const { parse } = require('query-string')
const path = require('path')

const cacheKeyInputs = [
  'background',
  'crop',
  'crop_strategy',
  'fit',
  'gravity',
  'h',
  'lb',
  'quality',
  'resize',
  'w',
  'webp',
  'zoom',
]

const calcCacheHash = args => {
  const cacheArgs = cacheKeyInputs.reduce(
    (acc, key) => ({ ...acc, ...(args[key] ? { [key]: args[key] } : {}) }),
    {}
  )
  if (!Object.keys(cacheArgs).length) return null
  return hash(cacheArgs)
}

const determineCacheKey = (key, args) => {
  const hash = calcCacheHash(args)
  // if there's no hash, we deliver the unprocessed file
  if (!hash) return key
  const dir = path.dirname(key)
  const ext = path.extname(key)
  const file = path.basename(key, ext)
  return `cache/${dir}/${file}_${hash}${ext}`
}

const mkGetHeader = request => name => {
  const header = request.headers[name.toLowerCase()]
  return header && header.length ? header[0].value : null
}

const getArgs = request => {
  const args = parse(request.querystring)
  if (typeof args.webp === 'undefined') {
    args.webp = !!mkGetHeader(request)('X-WebP')
  }
  return args
}

const getS3Key = uri =>
  decodeURIComponent(uri.substring(1)).replace('/uploads/tachyon/', '/uploads/')

const mkGetEnv = request => name => {
  const headerName = `x-env-${name.toLowerCase().replace(/_/g, '-')}`
  const header = request.origin.s3.customHeaders[headerName]
  return header && header.length ? header[0].value : null
}

module.exports = { determineCacheKey, mkGetHeader, getArgs, getS3Key, mkGetEnv }
