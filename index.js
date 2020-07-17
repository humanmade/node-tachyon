var sharp = require('sharp'),
	AWSXRay = require('aws-xray-sdk-core'),
	fs = require('fs'),
	path = require('path'),
	isAnimated = require('animated-gif-detector'),
	smartcrop = require('smartcrop-sharp'),
	imageminPngquant = require('imagemin-pngquant'),
	querystring = require('querystring');
const { config } = require('process');

const localConfigFilename = './lambda-config.json';
const isLocalConfig = process.env.S3_REGION ? false : true;
const localConfig = 
	isLocalConfig && fs.existsSync( localConfigFilename ) ?
	JSON.parse( fs.readFileSync( localConfigFilename ) ) : {};

const cfg = isLocalConfig ? localConfig : process.env;

const enableTracing = cfg.AWS_XRAY_DAEMON_ADDRESS;
const authenticatedRequest = !!cfg.S3_AUTHENTICATED_REQUEST ? 
	cfg.S3_AUTHENTICATED_REQUEST.toLowerCase() == 'true' : false;

let AWS;
if ( enableTracing ) {
	AWS = AWSXRay.captureAWS(require('aws-sdk'));
} else {
	AWS = require('aws-sdk');
}

var regions = {};

module.exports = {};

module.exports.s3 = function(config, key, args, callback) {
	AWS.config.region = config.region;

	var s3config = {};
	if (config.endpoint) {
		s3config.endpoint = config.endpoint;
	}

	if (!regions[config.region]) {
		regions[config.region] = new AWS.S3(
			Object.assign({ region: config.region }, s3config)
		);
	}

	var s3 = regions[config.region];
	var isPresigned = !! args['X-Amz-Algorithm'];

	if ( authenticatedRequest ) {
		request = s3.makeRequest( 'getObject', { Bucket: config.bucket, Key: key } );
	} else {
		request = s3.makeUnauthenticatedRequest( 'getObject', { Bucket: config.bucket, Key: key } );
		// To support forwarding presigned URLs, we hook into the post `build` step to add/forward
		// the Amz signing URL query params from the current request.
		if ( isPresigned ) {
			// All the URL params that should be forwarded from the current request to the S3 file request.
			const presignedParams = [
				'X-Amz-Algorithm',
				'X-Amz-Content-Sha256',
				'X-Amz-Credential',
				'X-Amz-SignedHeaders',
				'X-Amz-Expires',
				'X-Amz-Signature',
				'X-Amz-Date',
				'X-Amz-Security-Token',
			];
			// Append the presigned URL params to the S3 file request URL.
			request.addListener( 'build', function ( req ) {
				const urlParams = presignedParams.reduce( ( params, urlParam ) => {
					if ( args[ urlParam ] ) {
						params[ urlParam ] = args[ urlParam ];
					}
					return params;
				}, {} );
				req.httpRequest.path += `?${ querystring.stringify( urlParams ) }`;
			});
		}
	}
	request.send( function ( err, data ) {
		if ( err ) {
			return callback( err );
		}

		args.key = key;

		return module.exports.resizeBuffer( data.Body, args, callback );
	} );

	return request;
};

const getDimArray = function( dims, zoom ) {
	var dimArr = typeof dims === 'string' ? dims.split(',') : dims;
	zoom = zoom || 1;
	return dimArr.map(function(v) {
		return Math.round((Number(v) * zoom)) || null;
	});
}

const clamp = function( val, min, max ) {
	return Math.min( Math.max( Number( val ), min ), max );
}

// return a default compression value based on a logarithmic scale
// defaultValue = 100, zoom = 2; = 65
// defaultValue = 80, zoom = 2; = 50
// defaultValue = 100, zoom = 1.5; = 86
// defaultValue = 80, zoom = 1.5; = 68
const applyZoomCompression = function ( defaultValue, zoom ) {
	const value = Math.round( defaultValue - ( ( Math.log( zoom ) / Math.log( defaultValue / zoom ) ) * ( defaultValue * zoom ) ) );
	const min = Math.round( defaultValue / zoom );
	return clamp( value, min, defaultValue );
}

module.exports.resizeBuffer = async function(buffer, args, callback) {
	try {
		const image = sharp(buffer, {failOnError: false}).withMetadata();

		// check we can get valid metadata
		const metadata = await image.metadata();

		// auto rotate based on orientation exif data
		image.rotate();

		// convert gifs to pngs unless animated
		if (
			args.key &&
			path.extname(args.key).toLowerCase() === '.gif'
		) {
			if (isAnimated(buffer)) {
				return callback(new Error('fallback-to-original'));
			} else {
				image.png();
			}
		}

		// crop (assumes crop data from original)
		if (args.crop) {
			var cropValues =
				typeof args.crop === 'string'
					? args.crop.split(',')
					: args.crop;

			// convert percentages to px values
			cropValues = cropValues.map(function(value, index) {
				if (value.indexOf('px') > -1) {
					return Number(value.substr(0, value.length - 2));
				} else {
					return Number(
						Number(
							metadata[index % 2 ? 'height' : 'width'] *
								(value / 100)
						).toFixed(0)
					);
				}
			});

			image.extract({
				left: cropValues[0],
				top: cropValues[1],
				width: cropValues[2],
				height: cropValues[3],
			});
		}

		// get zoom value
		const zoom = parseFloat( args.zoom ) || 1;

		// resize
		if (args.resize) {
			// apply smart crop if available
			if (args.crop_strategy === 'smart' && ! args.crop) {
				const cropResize = getDimArray( args.resize );
				const rotatedImage = await image.toBuffer();
				const result = await smartcrop.crop(rotatedImage, { width: cropResize[0], height: cropResize[1] });

				if (result && result.topCrop) {
					image.extract({
						left: result.topCrop.x,
						top: result.topCrop.y,
						width: result.topCrop.width,
						height: result.topCrop.height,
					});
				}
			}

			// apply the resize
			args.resize = getDimArray( args.resize, zoom );
			image.resize({
				width: args.resize[0],
				height: args.resize[1],
				withoutEnlargement: true,
				position: ( args.crop_strategy !== 'smart' && args.crop_strategy ) || args.gravity || 'centre',
			});
		} else if (args.fit) {
			args.fit = getDimArray( args.fit, zoom );
			image.resize({
				width: args.fit[0],
				height: args.fit[1],
				fit: 'inside',
				withoutEnlargement: true,
			});
		} else if (args.lb) {
			args.lb = getDimArray( args.lb, zoom );
			image.resize({
				width: args.lb[0],
				height: args.lb[1],
				fit: 'contain',
				// default to a black background to replicate Photon API behaviour
				// when no background colour specified
				background: args.background || 'black',
				withoutEnlargement: true,
			});
		} else if (args.w || args.h) {
			image.resize({
				width: (Number(args.w) * zoom) || null,
				height: (Number( args.h ) * zoom) || null,
				fit: args.crop ? 'cover' : 'inside',
				withoutEnlargement: true,
			});
		}

		// set default quality slightly higher than sharp's default
		if ( ! args.quality ) {
			args.quality = applyZoomCompression( 82, zoom );
		}

		// allow override of compression quality
		if (args.webp) {
			image.webp({
				quality: Math.round( clamp( args.quality, 0, 100 ) ),
			});
		} else if (metadata.format === 'jpeg') {
			image.jpeg({
				quality: Math.round( clamp( args.quality, 0, 100 ) ),
			});
		}

		// send image
		return new Promise((resolve, reject) => {
			image.toBuffer(async (err, data, info) => {
				if (err) {
					reject(err);
				}

				// Pass PNG images through PNGQuant as Sharp is not good at compressing them.
				// See https://github.com/lovell/sharp/issues/478
				if ( info.format === 'png' ) {

					if ( enableTracing ) {
						var mainSegment = AWSXRay.getSegment();
						var segment = mainSegment.addNewSubsegment( 'imagemin-pngquant' );
					}

					data = await imageminPngquant()( data );

					if ( enableTracing ) {
						segment.close();
					}

					// Make sure we update the size in the info, to reflect the new
					// size after lossless-compression.
					info.size = data.length;
				}

				callback && callback(null, data, info);
				resolve({ data, info });
			});
		});
	} catch (err) {
		callback && callback(err);
		return err;
	}
};
