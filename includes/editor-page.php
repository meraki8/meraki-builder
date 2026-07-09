<?php
/**
 * The full-screen editor page and its entry points.
 *
 * @package Meraki_Builder
 */

defined( 'ABSPATH' ) || exit;

function meraki_builder_edit_url( $post_id ) {
	return admin_url( 'admin.php?action=meraki_builder&post=' . (int) $post_id );
}

/**
 * "Edit with Meraki Builder" button on the page edit screen.
 */
function meraki_builder_meta_box() {
	add_meta_box(
		'meraki-builder',
		__( 'Meraki Builder', 'meraki-builder' ),
		function ( $post ) {
			if ( 'auto-draft' === $post->post_status ) {
				echo '<p>' . esc_html__( 'Save the page first, then edit it with Meraki Builder.', 'meraki-builder' ) . '</p>';
				return;
			}
			printf(
				'<a class="button button-primary button-large" style="width:100%%;text-align:center" href="%s">%s</a>',
				esc_url( meraki_builder_edit_url( $post->ID ) ),
				esc_html__( 'Edit with Meraki Builder', 'meraki-builder' )
			);
			if ( get_post_meta( $post->ID, '_meraki_builder_enabled', true ) ) {
				echo '<p class="description" style="margin-top:8px">' . esc_html__( 'This page is built with Meraki Builder; its builder layout replaces the editor content on the front end.', 'meraki-builder' ) . '</p>';
			}
		},
		'page',
		'side',
		'high'
	);
}
add_action( 'add_meta_boxes', 'meraki_builder_meta_box' );

/**
 * Row action on the Pages list.
 */
function meraki_builder_row_action( $actions, $post ) {
	if ( 'page' === $post->post_type && current_user_can( 'edit_page', $post->ID ) ) {
		$actions['meraki_builder'] = sprintf(
			'<a href="%s">%s</a>',
			esc_url( meraki_builder_edit_url( $post->ID ) ),
			esc_html__( 'Meraki Builder', 'meraki-builder' )
		);
	}
	return $actions;
}
add_filter( 'page_row_actions', 'meraki_builder_row_action', 10, 2 );

/**
 * Full-screen editor: our own document, printed before the admin
 * chrome renders.
 */
function meraki_builder_editor_page() {
	$post_id = isset( $_GET['post'] ) ? (int) $_GET['post'] : 0;
	$post    = get_post( $post_id );

	if ( ! $post || 'page' !== $post->post_type || ! current_user_can( 'edit_page', $post_id ) ) {
		wp_die( esc_html__( 'You are not allowed to edit this page with Meraki Builder.', 'meraki-builder' ) );
	}

	$tree = null;
	$json = get_post_meta( $post_id, '_meraki_builder_tree', true );
	if ( $json ) {
		$decoded = json_decode( $json, true );
		$tree    = is_array( $decoded ) ? $decoded : null;
	}

	$boot = array(
		'post'    => $post_id,
		'title'   => $post->post_title,
		'tree'    => $tree,
		'restUrl' => esc_url_raw( rest_url( 'meraki-builder/v1/save' ) ),
		'nonce'   => wp_create_nonce( 'wp_rest' ),
		'exitUrl' => get_edit_post_link( $post_id, 'raw' ),
		'viewUrl' => get_permalink( $post_id ),
		'maxDepth' => MERAKI_BUILDER_MAX_DEPTH,
	);

	$theme_css = array();
	if ( is_child_theme() ) {
		$theme_css[] = get_template_directory_uri() . '/style.css';
	}
	$theme_css[] = get_stylesheet_uri();

	header( 'Content-Type: text/html; charset=utf-8' );
	?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?php echo esc_html( sprintf( __( 'Meraki Builder — %s', 'meraki-builder' ), $post->post_title ) ); ?></title>
<?php foreach ( $theme_css as $href ) : ?>
<link rel="stylesheet" href="<?php echo esc_url( $href ); ?>">
<?php endforeach; ?>
<link rel="stylesheet" href="<?php echo esc_url( MERAKI_BUILDER_URL . 'assets/frontend.css?ver=' . MERAKI_BUILDER_VERSION ); ?>">
<link rel="stylesheet" href="<?php echo esc_url( MERAKI_BUILDER_URL . 'assets/editor.css?ver=' . MERAKI_BUILDER_VERSION ); ?>">
</head>
<body class="mb-editor-body">
<div id="mb-root"></div>
<script>window.MERAKI_BUILDER = <?php echo wp_json_encode( $boot ); ?>;</script>
<script src="<?php echo esc_url( MERAKI_BUILDER_URL . 'editor/build/editor.js?ver=' . MERAKI_BUILDER_VERSION ); ?>"></script>
</body>
</html>
	<?php
	exit;
}
add_action( 'admin_action_meraki_builder', 'meraki_builder_editor_page' );
