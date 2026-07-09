<?php
/**
 * Plugin Name: Meraki Builder
 * Plugin URI: https://github.com/meraki8/meraki-builder
 * Description: A quiet visual page builder for the Meraki theme.
 * Version: 0.1.1
 * Requires at least: 6.6
 * Requires PHP: 7.4
 * Author: Meraki
 * Author URI: https://meraki8.io
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: meraki-builder
 * Update URI: https://projec-meraki-app-production.up.railway.app/updates/meraki-builder.json
 *
 * @package Meraki_Builder
 */

defined( 'ABSPATH' ) || exit;

define( 'MERAKI_BUILDER_VERSION', '0.1.1' );
define( 'MERAKI_BUILDER_DIR', plugin_dir_path( __FILE__ ) );
define( 'MERAKI_BUILDER_URL', plugin_dir_url( __FILE__ ) );
define( 'MERAKI_BUILDER_UPDATE_URL', 'https://projec-meraki-app-production.up.railway.app/updates/meraki-builder.json' );
define( 'MERAKI_BUILDER_MAX_DEPTH', 10 );

require MERAKI_BUILDER_DIR . 'includes/sanitize.php';
require MERAKI_BUILDER_DIR . 'includes/render.php';
require MERAKI_BUILDER_DIR . 'includes/rest.php';

if ( is_admin() ) {
	require MERAKI_BUILDER_DIR . 'includes/editor-page.php';
}

/**
 * Updates via PROJEC+ MERAKI (vendored plugin-update-checker).
 */
function meraki_builder_update_checker() {
	$puc = MERAKI_BUILDER_DIR . 'includes/plugin-update-checker/plugin-update-checker.php';

	if ( ! file_exists( $puc ) ) {
		return;
	}

	require_once $puc;

	YahnisElsts\PluginUpdateChecker\v5\PucFactory::buildUpdateChecker(
		MERAKI_BUILDER_UPDATE_URL,
		__FILE__,
		'meraki-builder'
	);
}
add_action( 'init', 'meraki_builder_update_checker' );
