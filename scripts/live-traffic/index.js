/**
 * Compare WebP and AVIF files from live access logs data.
 *
 * This script will simulate the effectiveness of AVIF images over WebP based off
 * live traffic data from CloudFront Access logs. This is to provide a measurement of
 * best defaults when both WebP and AVIF is supported.
 *
 * This script expects a filer path of JSON data of CloudFront requests, formated by the Altis Cloud
 * Dashboard API.
 *
 * Example usage: node index.js ./tachyon-access-logs.json --bucket=hmn-uploads --prefix=humanmade-production
 *
 * This will match tachyon access log entries with the s3 file, download the S3 files and generate webp and avif images
 * at the size and args in the query string from the access log. The script will take the top 1000 post popular image
 * requests from the access log, and generate the predicted total data usage comparison between WebP and AVIF.
 *
 * Images will be downloaded to the "./images" directory, as a cache. This means the script can be tweaked, or implementation changed
 * without needing to re-download S3 images.
 */
const fs = require('fs');
const AWS = require('aws-sdk');
const cliProgress = require('cli-progress');
const tachyon = require('../../index');
const args = require('yargs/yargs')(require('yargs/helpers').hideBin(process.argv)).argv
const S3 = new AWS.S3();

const filePath = args._[0];
const s3Bucket = args.bucket;
const s3Prefix = args.prefix;

let requests = String( fs.readFileSync( filePath ) ).split( "\n" );

// parse JSON logs to only the data we need.
requests = requests.map( line => {
	line = line.endsWith(',') ? line.substr(0, line.length - 1 ) : line;
	try {
		line = JSON.parse( line );
	} catch {

	}
	return { file: line['cs-uri-stem'], args: line['cs-uri-query'] }
} );


// Group requests by file & args and count uniques.
requests = requests.reduce( ( all, item ) => {
	const key = `${ item.file }?${ item.args || '' }`;
	all[ key ] = all[ key ] ? all[ key ] + 1 : 1;
	return all;
}, {} );

requests = Object.entries( requests );

// Sort requests by total requests, so we can pick the top N images.
requests = requests.sort( ( a, b ) => a[1] > b[1] ? -1 : 1 );
requests = requests.slice( 0, 1000 );

// Parse back out the file and args from the flat map
requests = requests.map( r => {
	let [ path, args ] = r[0].split( '?' );
	args = args.length === 0 ? {} : args.split( '&' ).reduce( ( all, item ) => {
		all[ item.split('=')[0] ] = item.split('=')[1];
		return all;
	}, {} )
	path = path.replace( '/tachyon/', '/uploads/' );
	return {
		path,
		args,
		count: r[1],
	}
} );


(async () => {
	const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
	progress.start( requests.length, 0 )
	for (let index = 0; index < requests.length; index++) {
		const item = requests[index];
		item.filePath = `${ __dirname }/images/${ item.path.split( '/' ).join( '-' ) }`;
		let fileBuffer = null;
		progress.increment();
		if ( ! fs.existsSync( item.filePath ) ) {
			try {
				const file = await S3.makeUnauthenticatedRequest( 'getObject', { Bucket: s3Bucket, Key: s3Prefix + item.path } ).promise();
				fs.writeFileSync( item.filePath, file.Body );
				fileBuffer = file.Body;
			} catch {
				requests[index] = null;
				continue;
			}
		} else {
			fileBuffer = fs.readFileSync( item.filePath );
		}

		const startWebp = new Date().getTime();
		const webp = await tachyon.resizeBuffer( fileBuffer, { ...item.args, webp: true } );
		const endWebp = new Date().getTime();

		const startAvif = new Date().getTime();
		const avif = await tachyon.resizeBuffer( fileBuffer, { ...item.args, avif: true } );
		const endAvif = new Date().getTime();

		item.webp = webp.info.size;
		item.webpTime = endWebp - startWebp;
		item.avif = avif.info.size;
		item.avifTime = endAvif - startAvif;
		item.ratio = item.webp / item.avif;
	}
	progress.stop();
	requests = requests.filter( Boolean );
	let bytesOfWebp = 0;
	let bytesOfAvif = 0;
	let timeWebp = 0;
	let timeAvif = 0;
	let totalSmaller = 0;

	fs.writeFileSync( __dirname + '/results.json', JSON.stringify( requests, null, 4 ) );

	requests.forEach( item => {
		bytesOfWebp += item.webp * item.count;
		bytesOfAvif += item.avif * item.count;
		timeWebp += item.webpTime;
		timeAvif += item.avifTime;
		if ( item.avif < item.webp ) {
			totalSmaller += 1;
		}
	} );

	console.log( `Based off request counts, WebP total data: ${ ( bytesOfWebp / 1024 / 1024 / 1024 ).toFixed(2) }GB vs Avif: ${ ( bytesOfAvif / 1024 / 1024 / 1024 ).toFixed(2) }GB` );
	console.log( `Avif files ${ 100 - ( Math.round( bytesOfAvif / bytesOfWebp * 100 ) ) }% smaller in total` );
	console.log( `${ totalSmaller } of ${ requests.length } avif files were smaller than webp.` );
	console.log( `${ timeWebp }ms in webp, ${ timeAvif }ms in avif.` );

	requests.sort( (a,b) => a.ratio > b.ratio ? -1 : 1 );
})();
