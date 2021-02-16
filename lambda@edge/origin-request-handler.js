const { determineCacheKey, getArgs, getS3Key } = require('./lib')

// the origin-request handler replaces the original tachyon uri, with the uri of the cache file
// since the original uri is needed in the origin-response handler, it is passed on via the "X-Request-Uri" header
exports.handler = async ({
  Records: [
    {
      cf: { request },
    },
  ],
}) => ({
  ...request,
  uri: `/${determineCacheKey(getS3Key(request.uri), getArgs(request))}`,
  headers: {
    ...request.headers,
    'x-request-uri': [{ key: 'X-Request-Uri', value: request.uri }],
  },
})
