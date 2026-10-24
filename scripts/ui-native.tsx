import React from "react";
const clean = (props: Record<string, any>) => {
  const { accessibilityRole, accessibilityLabel, accessibilityState, onPress, onChangeText, contentContainerStyle,
    placeholderTextColor, selectable, multiline, textAlignVertical, ...rest } = props;
  return { ...rest, role: accessibilityRole, "aria-label": accessibilityLabel };
};
// React Native draws a solid border whenever a border width is supplied.
const nativeStyle = (style: any) => ({
  ...(style?.borderWidth || style?.borderLeftWidth ? { borderStyle: "solid", borderWidth: 0 } : {}), ...style,
});
export const View = (props: any) => <div {...clean(props)} style={{ display: "flex", flexDirection: "column", ...nativeStyle(props.style) }} />;
export const Text = (props: any) => <span {...clean(props)} style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...nativeStyle(props.style) }} />;
export const ScrollView = (props: any) => <div style={{ overflow: "auto", ...nativeStyle(props.style) }}><div style={{ display: "flex", flexDirection: "column", ...props.contentContainerStyle }}>{props.children}</div></div>;
export const Pressable = (props: any) => <button {...clean(props)} type="button" onClick={props.onPress} style={{ font: "inherit", cursor: props.disabled ? "default" : "pointer", background: "transparent", border: 0, textAlign: "left", opacity: props.disabled ? 0.5 : 1, ...nativeStyle(props.style) }} />;
export const TextInput = (props: any) => {
  const Tag = props.multiline ? "textarea" : "input";
  return <Tag {...clean(props)} onChange={(event: any) => props.onChangeText?.(event.target.value)} style={{ font: "inherit", background: "transparent", ...nativeStyle(props.style) }} />;
};
