// the viewer-request handler sets the 'X-WebP' header, when appropriate
exports.handler = async ({
  Records: [
    {
      cf: { request },
    },
  ],
}) => ({
  ...request,
  headers: {
    ...request.headers,
    ...(request.headers.accept &&
    request.headers.accept[0].value.includes('image/webp')
      ? { 'x-webp': [{ key: 'X-WebP', value: '1' }] }
      : {}),
  },
})
