var tachyon = require('./index');
var proxyFile = require('./proxy-file');
const fs = require('fs');
const querystring = require('querystring');

const localConfigFilename = './lambda-config.json';
const isLocalConfig = process.env.S3_REGION ? false : true;
const localConfig = 
	isLocalConfig && fs.existsSync( localConfigFilename ) ?
	JSON.parse( fs.readFileSync( localConfigFilename ) ) : {};

const cfg = isLocalConfig ? localConfig : process.env;

const region = cfg.S3_REGION;
const bucket = cfg.S3_BUCKET;

exports.handler = function(event, context, callback) {

	// adapt request for lambda edge, if no event.path
	if (!event.path && event.Records && event.Records.length > 0) {
		let request = event.Records[0].cf.request;
		event.headers = request.headers;
		event.path = request.uri;
		event.queryStringParameters = querystring.parse(request.querystring);
	}

	var key = decodeURIComponent(event.path.substring(1));
	key = key.replace( '/uploads/tachyon/', '/uploads/' );
	var args = event.queryStringParameters || {};
	if ( typeof args.webp === 'undefined' ) {
		args.webp = !!(event.headers && event.headers['X-WebP']);
	}
	return tachyon.s3({ region: region, bucket: bucket }, key, args, function(
		err,
		data,
		info
	) {
		if (err) {
			if (err.message === 'fallback-to-original') {
				return proxyFile({ region: region }, bucket, key, callback);
			} else if ( err.code === 'AccessDenied' ) {
				// An AccessDenied error means the file is either protected, or doesn't exist.
				// We don't get a NotFound error because Tachyon makes unauthenticated calls
				// so S3.
				var resp = {
					statusCode: 404,
					body: "File not found.",
					isBase64Encoded: false,
				};
				return callback(null, resp);
			}
			return context.fail(err);
		}
		// If this is a signed URL, we need to calculate the max-age of the image.
		let maxAge = 31536000;
		if ( args['X-Amz-Expires'] ) {
			// Date format of X-Amz-Date is YYYYMMDDTHHMMSSZ, which is not parsable by Date.
			const dateString = args['X-Amz-Date'].replace( /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z' );
			const date = new Date( dateString );

			// Calculate when the signed URL will expire, as we'll set the max-age
			// cache control to this value.
			const expires = ( date.getTime() / 1000 ) + Number( args['X-Amz-Expires'] );

			// Mage age is the date the URL expires minus the current time.
			maxAge = Math.round( expires - ( new Date().getTime() / 1000 ) );
		}

		var resp = {
			body: Buffer.from(data).toString('base64')
		};
		
		if (isLocalConfig) {
			// prepare response for cloudfront, origin response
			resp.headers = {
				'content-type': [{key:'Content-Type', value: 'image/' + info.format}],
				'cache-control' : [{key:'Cache-Control', value: `max-age=${ maxAge }`}],
				'last-modified': [{key:'Last-Modified', value: (new Date()).toUTCString()}]
			};
			resp.bodyEncoding = 'base64';
			resp.status = '200';
			resp.statusDescription = "OK";
		} else {
			// prepare response for API gateway
			resp.headers = {
				'Content-Type': 'image/' + info.format,
				'Cache-Control': `max-age=${ maxAge }`,
				'Last-Modified': (new Date()).toUTCString()
			};
			resp.statusCode = 200;
			resp.isBase64Encoded = true;
		}
		
		callback(null, resp);

		data = null;
		info = null;
		err = null;
	});
};
