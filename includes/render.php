<?php
/**
 * Front-end rendering. Plain PHP — the editor never touches this path.
 * No JS, no data attributes, no inline styles; one optional <style>
 * element when nodes carry custom css.
 *
 * @package Meraki_Builder
 */

defined( 'ABSPATH' ) || exit;

/**
 * Decoded tree for a page, or null.
 */
function meraki_builder_get_tree( $post_id ) {
	if ( ! get_post_meta( $post_id, '_meraki_builder_enabled', true ) ) {
		return null;
	}
	$json = get_post_meta( $post_id, '_meraki_builder_tree', true );
	if ( ! $json ) {
		return null;
	}
	$tree = json_decode( $json, true );
	return is_array( $tree ) ? $tree : null;
}

/**
 * Layout classes ship only on pages that use the builder.
 */
function meraki_builder_enqueue() {
	if ( is_singular( 'page' ) && meraki_builder_get_tree( get_queried_object_id() ) ) {
		wp_enqueue_style(
			'meraki-builder',
			MERAKI_BUILDER_URL . 'assets/frontend.css',
			array(),
			MERAKI_BUILDER_VERSION
		);
	}
}
add_action( 'wp_enqueue_scripts', 'meraki_builder_enqueue' );

/**
 * Replace the_content with the rendered tree on builder pages.
 */
function meraki_builder_render_content( $content ) {
	if ( ! is_singular( 'page' ) || ! in_the_loop() || ! is_main_query() ) {
		return $content;
	}

	$tree = meraki_builder_get_tree( get_the_ID() );
	if ( ! $tree ) {
		return $content;
	}

	$css  = meraki_builder_collect_css( $tree );
	$html = meraki_builder_render_node( $tree, 0 );

	if ( '' !== $css ) {
		$html = '<style id="meraki-builder-custom-css">' . $css . '</style>' . $html;
	}

	return $html;
}
add_filter( 'the_content', 'meraki_builder_render_content', 9 );

/**
 * Render one node (recursive).
 */
function meraki_builder_render_node( $node, $depth ) {
	if ( $depth > MERAKI_BUILDER_MAX_DEPTH || empty( $node['type'] ) ) {
		return '';
	}

	$id    = isset( $node['id'] ) ? preg_replace( '/[^a-z0-9]/', '', strtolower( $node['id'] ) ) : '';
	$props = isset( $node['props'] ) ? (array) $node['props'] : array();

	if ( 'container' === $node['type'] ) {
		// Depth 0 is the page root: always full width and always flex,
		// regardless of stored props (pre-0.1.1 trees carry width=contained).
		$width  = 0 === $depth ? 'full' : ( 'full' === ( $props['width'] ?? '' ) ? 'full' : 'contained' );
		$gap    = in_array( $props['gap'] ?? '', array( 'none', 'sm', 'md', 'lg' ), true ) ? $props['gap'] : 'md';
		// Absent layout = flex (pre-0.3.0 trees) — emits exactly the legacy classes.
		$layout = ( 0 !== $depth && in_array( $props['layout'] ?? '', array( 'div', 'grid' ), true ) ) ? $props['layout'] : 'flex';

		$classes = array( 'm-' . $id, 'mb-container' );
		if ( 'flex' === $layout ) {
			$classes[] = 'mb-' . ( 'row' === ( $props['direction'] ?? '' ) ? 'row' : 'column' );
			$classes[] = 'mb-gap-' . $gap;
		} elseif ( 'grid' === $layout ) {
			$classes[] = 'mb-grid';
			$classes[] = 'mb-gap-' . $gap;
		} else {
			$classes[] = 'mb-div';
		}
		$classes[] = 'mb-' . $width;

		if ( in_array( $props['padding'] ?? 'none', array( 'sm', 'md', 'lg' ), true ) ) {
			$classes[] = 'mb-pad-' . $props['padding'];
		}

		$inner = '';
		if ( ! empty( $node['children'] ) && is_array( $node['children'] ) ) {
			foreach ( $node['children'] as $child ) {
				$inner .= meraki_builder_render_node( $child, $depth + 1 );
			}
		}

		return sprintf( '<div class="%s">%s</div>', esc_attr( implode( ' ', $classes ) ), $inner );
	}

	if ( 'text' === $node['type'] ) {
		$tag     = in_array( $props['tag'] ?? '', array( 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p' ), true ) ? $props['tag'] : 'p';
		$content = meraki_builder_sanitize_text_content( $props['content'] ?? '' );

		return sprintf( '<%1$s class="m-%2$s">%3$s</%1$s>', $tag, esc_attr( $id ), $content );
	}

	return '';
}

/**
 * Builder pages have empty post_content, so WP can't generate an
 * excerpt (used by the theme for meta descriptions and by search
 * results). Derive one from the tree's text nodes.
 */
function meraki_builder_excerpt( $excerpt, $post ) {
	if ( '' !== trim( (string) $excerpt ) || ! $post || 'page' !== $post->post_type ) {
		return $excerpt;
	}
	$tree = meraki_builder_get_tree( $post->ID );
	if ( ! $tree ) {
		return $excerpt;
	}
	$text = trim( meraki_builder_tree_text( $tree ) );
	return $text ? wp_trim_words( $text, 30 ) : $excerpt;
}
add_filter( 'get_the_excerpt', 'meraki_builder_excerpt', 10, 2 );

function meraki_builder_tree_text( $node ) {
	$text = '';
	if ( 'text' === ( $node['type'] ?? '' ) ) {
		$text .= wp_strip_all_tags( $node['props']['content'] ?? '' ) . ' ';
	}
	foreach ( (array) ( $node['children'] ?? array() ) as $child ) {
		$text .= meraki_builder_tree_text( $child );
	}
	return $text;
}

/**
 * Gather non-empty per-node css, resolving "selector" to .m-{id}.
 */
function meraki_builder_collect_css( $node ) {
	$css = '';

	if ( ! empty( $node['css'] ) ) {
		$id   = preg_replace( '/[^a-z0-9]/', '', strtolower( $node['id'] ?? '' ) );
		$rule = meraki_builder_sanitize_css( $node['css'] );
		if ( '' !== $rule && '' !== $id ) {
			$css .= str_replace( 'selector', '.m-' . $id, $rule ) . "\n";
		}
	}

	if ( ! empty( $node['children'] ) && is_array( $node['children'] ) ) {
		foreach ( $node['children'] as $child ) {
			$css .= meraki_builder_collect_css( $child );
		}
	}

	return $css;
}
