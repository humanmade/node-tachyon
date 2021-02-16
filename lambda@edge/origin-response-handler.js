const { inspect } = require('util')
const AWS = require('aws-sdk')
const tachyon = require('../index')
const {
  determineCacheKey,
  getArgs,
  getS3Key,
  mkGetEnv,
  mkGetHeader,
} = require('./lib')

const tachyonS3 = (config, key, args) =>
  new Promise((resolve, reject) =>
    tachyon.s3(config, key, args, (err, data, info) => {
      if (err) {
        return reject(err)
      }
      resolve([data, info])
    })
  )

// the origin-respone handler looks at the response from the origin, if the requested image is not found in cache
// it tries to generate it by resizing the original image according to the query parameters
exports.handler = async ({
  Records: [
    {
      cf: { request, response },
    },
  ],
}) => {
  // return early if the image already exists in our cache
  // since we don't have the s3:ListBucket permission, s3 sends a 403 instead of a 404
  if (response.status !== '403') return response

  const getEnv = mkGetEnv(request)
  const getHeader = mkGetHeader(request)

  const region = getEnv('S3_REGION')
  const s3 = new AWS.S3({ region })
  const bucket = getEnv('S3_BUCKET')

  const args = getArgs(request)
  const uri = getHeader('X-Request-Uri')
  // since we change the uri in the origin request handler,
  // we pass the original uri via the X-Request-Uri header
  const key = getS3Key(uri)
  const cacheKey = determineCacheKey(key, args)

  console.log('origin response')
  console.log(inspect({ request, response }, Infinity))
  console.log({ args, cacheKey, key })

  const { querystring } = request

  process.env.S3_AUTHENTICATED_REQUEST = getEnv('S3_AUTHENTICATED_REQUEST')

  const redirect = {
    ...response,
    status: '302',
    statusDescription: 'Image resized successfully',
    headers: {
      ...response.headers,
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      location: [
        {
          key: 'Location',
          value: `${uri}${querystring.length ? `?${querystring}` : ''}`,
        },
      ],
    },
  }

  try {
    console.log('about to resize image...')
    const [data, info] = await tachyonS3({ bucket, region }, key, args)

    try {
      console.log('image format:')
      console.log({ info })
      console.log('about to save resized image to s3 bucket...')
      await s3
        .putObject({
          Bucket: bucket,
          Key: cacheKey,
          Body: Buffer.from(data),
          ACL: 'public-read',
          ContentType: `image/${info.format}`,
        })
        .promise()
      console.log('successfully saved image to s3 bucket!')
      return redirect
    } catch (err) {
      console.log('error while saving image to s3 bucket!')
      console.log({ err })
      throw err
    }
  } catch (err) {
    console.log('error while resizing image!')
    console.log({ err })
    if (err.message === 'fallback-to-original') {
      try {
        await s3
          .copyObject({
            Bucket: bucket,
            Key: cacheKey,
            CopySource: `/${bucket}/${key}`,
            ACL: 'public-read',
          })
          .promise()
        return redirect
      } catch (err) {
        console.log('error while copying animated gif!')
        throw err
      }
    } else if (err.code === 'AccessDenied') {
      // An AccessDenied error means the file is either protected, or doesn't exist.
      // We don't get a NotFound error because Tachyon makes unauthenticated calls
      // so S3.
      return {
        ...response,
        status: '404',
        statusDescription: 'File not found.',
      }
    }
    throw err
  }
}
