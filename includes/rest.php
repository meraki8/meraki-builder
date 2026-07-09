<?php
/**
 * Save endpoint. Cookie-authenticated REST with the standard wp_rest
 * nonce; the tree is whitelisted server-side before storage.
 *
 * @package Meraki_Builder
 */

defined( 'ABSPATH' ) || exit;

function meraki_builder_rest_routes() {
	register_rest_route(
		'meraki-builder/v1',
		'/save',
		array(
			'methods'             => 'POST',
			'permission_callback' => function ( $request ) {
				$post_id = (int) $request['post'];
				return $post_id > 0
					&& 'page' === get_post_type( $post_id )
					&& current_user_can( 'edit_page', $post_id );
			},
			'callback'            => 'meraki_builder_rest_save',
			'args'                => array(
				'post' => array( 'required' => true, 'type' => 'integer' ),
			),
		)
	);
}
add_action( 'rest_api_init', 'meraki_builder_rest_routes' );

function meraki_builder_rest_save( $request ) {
	$post_id = (int) $request['post'];
	$tree    = meraki_builder_sanitize_tree( $request['tree'] );

	if ( ! $tree ) {
		return new WP_Error( 'meraki_builder_invalid_tree', __( 'The layout could not be validated.', 'meraki-builder' ), array( 'status' => 400 ) );
	}

	update_post_meta( $post_id, '_meraki_builder_tree', wp_slash( wp_json_encode( $tree ) ) );
	update_post_meta( $post_id, '_meraki_builder_enabled', 1 );

	$title = $request['title'];
	if ( is_string( $title ) && '' !== trim( $title ) ) {
		wp_update_post(
			array(
				'ID'         => $post_id,
				'post_title' => sanitize_text_field( $title ),
			)
		);
	}

	// Builder pages render on the theme's blank canvas.
	if ( 'meraki' === get_template() && 'page-templates/full-width.php' !== get_page_template_slug( $post_id ) ) {
		update_post_meta( $post_id, '_wp_page_template', 'page-templates/full-width.php' );
	}

	return array(
		'saved' => true,
		'tree'  => $tree,
	);
}
