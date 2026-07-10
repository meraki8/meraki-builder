<?php
/**
 * Server-side tree sanitization. The stored tree is only ever what
 * survives this whitelist.
 *
 * @package Meraki_Builder
 */

defined( 'ABSPATH' ) || exit;

/**
 * Widget prop whitelists: type => prop => allowed values (array) or
 * a sanitizer callable.
 */
function meraki_builder_widget_schema() {
	return array(
		'container' => array(
			'layout'    => array( 'flex', 'div', 'grid' ),
			'direction' => array( 'column', 'row' ),
			'gap'       => array( 'md', 'none', 'sm', 'lg' ),
			'width'     => array( 'full', 'contained' ),
			'padding'   => array( 'none', 'sm', 'md', 'lg' ),
		),
		'text'      => array(
			'tag'     => array( 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p' ),
			'content' => 'meraki_builder_sanitize_text_content',
		),
	);
}

function meraki_builder_sanitize_text_content( $value ) {
	return wp_kses(
		(string) $value,
		array(
			'a'      => array( 'href' => true ),
			'strong' => array(),
			'em'     => array(),
			'code'   => array(),
			'br'     => array(),
		)
	);
}

/**
 * The css field ends up inside a <style> element. Strip anything that
 * could break out of it or reach the network.
 */
function meraki_builder_sanitize_css( $css ) {
	$css = (string) $css;
	$css = wp_strip_all_tags( $css );
	$css = str_replace( array( '<', '\\' ), '', $css );
	$css = preg_replace( '/@import|expression\s*\(|javascript:|behavior\s*:|url\s*\(/i', '', $css );
	return trim( substr( $css, 0, 5000 ) );
}

/**
 * Values from generated-style fields (styles.padding etc.) end up inside
 * a <style> element as declaration values. Strip anything that could
 * escape the declaration or the rule, plus the css-field blocklist.
 */
function meraki_builder_sanitize_style_value( $value ) {
	$value = trim( (string) $value );
	// Without ';' or '}' a value cannot escape its declaration or rule.
	$value = str_replace( array( '<', '\\', '{', '}', ';' ), '', $value );
	$value = preg_replace( '/@import|expression\s*\(|javascript:|behavior\s*:|url\s*\(/i', '', $value );
	return substr( $value, 0, 100 );
}

/**
 * Breakpoints (mirrored in src/tree.js BREAKPOINTS): desktop-first,
 * base emits bare rules, the rest max-width media queries in this
 * (descending) order.
 */
function meraki_builder_breakpoints() {
	return array(
		'base'    => null,
		'tabletL' => 1024,
		'tabletP' => 768,
		'mobile'  => 480,
	);
}

/**
 * styles whitelist: per-breakpoint buckets, each holding
 * padding.{top,right,bottom,left} and gap.{row,column}. Pre-0.4.0 flat
 * styles.padding is read as base.padding. Non-empty values only.
 */
function meraki_builder_sanitize_styles( $styles ) {
	// legacy flat shape -> base bucket
	if ( ! empty( $styles['padding'] ) && is_array( $styles['padding'] ) ) {
		$styles['base']['padding'] = array_merge( $styles['base']['padding'] ?? array(), $styles['padding'] );
		unset( $styles['padding'] );
	}

	$clean = array();
	foreach ( array_keys( meraki_builder_breakpoints() ) as $bp ) {
		$bucket = array();

		if ( ! empty( $styles[ $bp ]['padding'] ) && is_array( $styles[ $bp ]['padding'] ) ) {
			$padding = array();
			foreach ( array( 'top', 'right', 'bottom', 'left' ) as $side ) {
				$value = meraki_builder_sanitize_style_value( $styles[ $bp ]['padding'][ $side ] ?? '' );
				if ( '' !== $value ) {
					$padding[ $side ] = $value;
				}
			}
			if ( $padding ) {
				$bucket['padding'] = $padding;
			}
		}

		if ( ! empty( $styles[ $bp ]['gap'] ) && is_array( $styles[ $bp ]['gap'] ) ) {
			$gap = array();
			foreach ( array( 'row', 'column' ) as $axis ) {
				$value = meraki_builder_sanitize_style_value( $styles[ $bp ]['gap'][ $axis ] ?? '' );
				if ( '' !== $value ) {
					$gap[ $axis ] = $value;
				}
			}
			if ( $gap ) {
				$bucket['gap'] = $gap;
			}
		}

		if ( $bucket ) {
			$clean[ $bp ] = $bucket;
		}
	}
	return $clean;
}

/**
 * Recursively sanitize a decoded tree. Returns a clean node or null.
 *
 * @param array $node  Raw node from the client.
 * @param int   $depth Current depth (root = 0).
 */
function meraki_builder_sanitize_node( $node, $depth = 0 ) {
	if ( ! is_array( $node ) || $depth >= MERAKI_BUILDER_MAX_DEPTH ) {
		return null;
	}

	$schema = meraki_builder_widget_schema();
	$type   = isset( $node['type'] ) ? (string) $node['type'] : '';

	if ( ! isset( $schema[ $type ] ) ) {
		return null;
	}

	$id = isset( $node['id'] ) ? strtolower( (string) $node['id'] ) : '';
	if ( ! preg_match( '/^[a-z0-9]{4,12}$/', $id ) ) {
		$id = substr( md5( wp_rand() . microtime() ), 0, 6 );
	}

	$props = array();
	foreach ( $schema[ $type ] as $prop => $rule ) {
		$raw = isset( $node['props'][ $prop ] ) ? $node['props'][ $prop ] : null;
		if ( is_array( $rule ) ) {
			$props[ $prop ] = in_array( $raw, $rule, true ) ? $raw : $rule[0];
		} else {
			$props[ $prop ] = call_user_func( $rule, $raw );
		}
	}

	$children = array();
	if ( 'container' === $type && ! empty( $node['children'] ) && is_array( $node['children'] ) ) {
		foreach ( $node['children'] as $child ) {
			$clean = meraki_builder_sanitize_node( $child, $depth + 1 );
			if ( $clean ) {
				$children[] = $clean;
			}
		}
	}

	return array(
		'id'       => $id,
		'type'     => $type,
		'props'    => $props,
		'css'      => meraki_builder_sanitize_css( isset( $node['css'] ) ? $node['css'] : '' ),
		'styles'   => meraki_builder_sanitize_styles( is_array( $node['styles'] ?? null ) ? $node['styles'] : array() ),
		'children' => $children,
	);
}

/**
 * Sanitize a whole tree. The root must be a container, and root
 * children must be containers — non-containers are auto-wrapped
 * (same invariant the editor enforces on drop).
 */
function meraki_builder_sanitize_tree( $tree ) {
	$clean = meraki_builder_sanitize_node( $tree, 0 );
	if ( ! $clean || 'container' !== $clean['type'] ) {
		return null;
	}

	$children = array();
	foreach ( $clean['children'] as $child ) {
		if ( 'container' !== $child['type'] ) {
			$child = array(
				'id'       => substr( md5( wp_rand() . microtime() ), 0, 6 ),
				'type'     => 'container',
				'props'    => array(
					'layout'    => 'flex',
					'direction' => 'column',
					'gap'       => 'md',
					'width'     => 'full',
					'padding'   => 'none',
				),
				'css'      => '',
				'children' => array( $child ),
			);
		}
		$children[] = $child;
	}
	$clean['children'] = $children;

	// The root is the page, not a section: it never constrains width.
	// Sections (root children) decide their own width.
	$clean['props']['width'] = 'full';

	return $clean;
}
